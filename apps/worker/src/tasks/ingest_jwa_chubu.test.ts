// apps/worker/src/tasks/ingest_jwa_chubu.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { ensureExternalIds, parseChubuDate, parseChubuHtml } from './ingest_jwa_chubu.ts';

describe('parseChubuDate', () => {
  test('parses YYYY年MM月DD日 to JST midnight (= UTC day-1 15:00)', () => {
    const d = parseChubuDate('中部管内水源状況 2026年06月04日（木）');
    expect(d).not.toBeNull();
    expect(d?.toISOString()).toBe('2026-06-03T15:00:00.000Z');
  });

  test('parses single-digit month and day', () => {
    const d = parseChubuDate('2026年1月5日');
    expect(d?.toISOString()).toBe('2026-01-04T15:00:00.000Z');
  });

  test('returns null when no date present', () => {
    expect(parseChubuDate('no date here')).toBeNull();
  });
});

describe('parseChubuHtml', () => {
  // Verbatim capture of water.go.jp/mizu/chubu/report/ taken 2026-09-27
  // (report of 2026年09月25日（金）; the page is not updated at weekends).
  // Each dam block: <span class="dam-name">NAME</span>, 利水/有効容量,
  // [EL …] (0時の貯水位), 流入量/放流量 (前日平均), then 貯水量<br>&lt;午前0時&gt;
  // and (貯水率 …) in the next row.
  const FIXTURE = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    'tests/fixtures/jwa_chubu/report_2026-09-27.html',
  );
  const fixture = (): Promise<string> => readFile(FIXTURE, 'utf8');

  test('reads each dam from its own block at the report date', async () => {
    const { reportDate, rows } = parseChubuHtml(await fixture());
    expect(reportDate?.toISOString()).toBe('2026-09-24T15:00:00.000Z');
    expect(rows.map((r) => r.chubuName)).toEqual([
      '牧尾ダム',
      '阿木川ダム',
      '味噌川ダム',
      '岩屋ダム',
      '中里ダム',
      '徳山ダム',
    ]);
    expect(rows.find((r) => r.chubuName === '牧尾ダム')).toEqual({
      chubuName: '牧尾ダム',
      storageVolumeThouM3: 58_534,
      storageRatePct: 86.1,
      waterLevelM: 876.8,
      inflowM3s: 8.66,
      outflowM3s: 8.38,
    });
    expect(rows.find((r) => r.chubuName === '味噌川ダム')?.waterLevelM).toBe(1112.7);
  });

  test('takes 貯水量 at 午前0時, not the 有効貯水量 capacity printed above it', async () => {
    const tokuyama = parseChubuHtml(await fixture()).rows.find((r) => r.chubuName === '徳山ダム');
    expect(tokuyama?.storageVolumeThouM3).toBe(163_530);
    expect(tokuyama?.storageRatePct).toBe(63.5);
    expect(tokuyama?.outflowM3s).toBe(21.11);
  });

  test('中里ダム is read from its own block, not the 三重用水 合計 that names it first', async () => {
    // 「三重用水 (中里ダム・調整池合計)」 21,400 千m³ / 6,429 (30.0 %) comes
    // first on the page; 中里ダム's own block is 1,760 (11.0 %).
    const nakazato = parseChubuHtml(await fixture()).rows.find((r) => r.chubuName === '中里ダム');
    expect(nakazato).toEqual({
      chubuName: '中里ダム',
      storageVolumeThouM3: 1_760,
      storageRatePct: 11,
      waterLevelM: null,
      inflowM3s: 0.21,
      outflowM3s: 0.24,
    });
  });

  test('drops a dam whose 貯水量 or 貯水率 is not a number', async () => {
    const html = (await fixture()).replace(
      '<div class="databox">58,534</div>',
      '<div class="databox">―</div>',
    );
    const names = parseChubuHtml(html).rows.map((r) => r.chubuName);
    expect(names).not.toContain('牧尾ダム');
    expect(names).toContain('阿木川ダム');
  });
});

describe('ensureExternalIds binds 中里ダム to 三重用水 in 三重県', () => {
  // The report page lists 中里ダム under 三重用水 with 利水容量 16,000 千m³ —
  // the いなべ市 master (NDI 940), not the 長野 '中里' migration 0031 invented.
  const SLUGS = ['jwa-chubu-t-nakazato-mie', 'jwa-chubu-t-nakazato-nagano'];
  const KEY = '中里ダム';

  async function insertDam(slug: string, prefCode: string, stamped: boolean): Promise<bigint> {
    const ids = stamped ? { 'jwa-chubu': KEY } : {};
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, location, external_ids)
      VALUES (${slug}, '中里', ${prefCode},
              ST_SetSRID(ST_MakePoint(136.48, 35.22), 4326)::geography, ${sql.json(ids)})
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  async function stampOf(id: bigint): Promise<string | null> {
    const rows = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'jwa-chubu' AS k FROM dams WHERE id = ${id}
    `;
    return rows[0]?.k ?? null;
  }

  let universeBefore: string[] = [];
  let runBefore = false;
  beforeAll(async () => {
    const rows = await sql<{ k: string }[]>`
      SELECT source_external_id AS k FROM source_universe WHERE source_id = 'jwa-chubu'
    `;
    universeBefore = rows.map((r) => r.k);
    const runs = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = 'jwa-chubu'`;
    runBefore = runs.length > 0;
  });
  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
    await sql`
      DELETE FROM source_universe
      WHERE source_id = 'jwa-chubu' AND NOT (source_external_id = ANY(${universeBefore}))
    `;
    if (!runBefore) await sql`DELETE FROM source_universe_runs WHERE source_id = 'jwa-chubu'`;
  });

  test('the 三重 row wins over a 長野 namesake that holds the stamp', async () => {
    const mie = await insertDam(SLUGS[0] as string, '24', false);
    const nagano = await insertDam(SLUGS[1] as string, '20', true);

    const matches = await ensureExternalIds(() => {});

    expect(matches.find((m) => m.chubuName === KEY)?.damId.toString()).toBe(mie.toString());
    expect(await stampOf(mie)).toBe(KEY);
    expect(await stampOf(nagano)).toBeNull();
  });
});
