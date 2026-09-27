// apps/worker/src/tasks/ingest_jwa_junpo.test.ts
//
// Parser tests against a verbatim capture of the live page from 2026-04-21.
// The values asserted below are eyeballed against the page, so changing
// them on a parser refactor should fail loudly.
//
// ensureExternalIds is exercised against the real 牧尾 （元）/（再） pair
// (the backfill binds through it too).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { ensureExternalIds, parseJwaJunpoHtml, parseReportDate } from './ingest_jwa_junpo.ts';

const FIXTURE_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa-junpo/index_2026-04-21.html',
);

describe('parseReportDate', () => {
  test('parses 「令和N年M月D日」 to JST midnight (= 15:00 UTC of D-1)', () => {
    const d = parseReportDate('最新の情報　令和8年4月21日（火）');
    expect(d).not.toBeNull();
    // Reiwa 8 = 2026; April 21 JST midnight = April 20 15:00 UTC.
    expect(d?.toISOString()).toBe('2026-04-20T15:00:00.000Z');
  });

  test('returns null when no Reiwa-formatted date is present', () => {
    expect(parseReportDate('something else')).toBeNull();
  });
});

describe('parseJwaJunpoHtml', () => {
  test('extracts exactly one row per known dam (no rainfall-table duplicates)', async () => {
    const html = await readFile(FIXTURE_PATH, 'utf8');
    const { reportDate, rows } = parseJwaJunpoHtml(html);
    expect(reportDate).not.toBeNull();
    // 26 dams in NAME_MAP; the fixture is the live index so all should match.
    expect(rows.length).toBe(26);
    // 旬報 page also has a 「ダムの降水量等」 table that lists the same dam
    // names with rainfall numbers — a previous version of the parser walked
    // it as well and produced 52 rows with garbage capacity / volume / rate.
    const names = rows.map((r) => r.jwaName);
    expect(new Set(names).size).toBe(rows.length);
  });

  test('gets numbers right for a sample of dams', async () => {
    const html = await readFile(FIXTURE_PATH, 'utf8');
    const { rows } = parseJwaJunpoHtml(html);
    const byName = new Map(rows.map((r) => [r.jwaName, r]));
    // 矢木沢: 利水容量 115,500 / 貯水量 105,598 / 貯水率 91.4%
    expect(byName.get('矢木沢ダム')).toMatchObject({
      storageCapacityThouM3: 115500,
      storageVolumeThouM3: 105598,
      storageRatePct: 91.4,
    });
    // 早明浦: 利水容量 ?, 貯水率 100%, capacity from junpo table (not full)
    expect(byName.get('早明浦ダム')?.storageRatePct).toBeCloseTo(100, 1);
    // 下久保: low storage 29.3%
    expect(byName.get('下久保ダム')?.storageRatePct).toBeCloseTo(29.3, 1);
  });

  test('skips synthesis rows (上流9ダム, 銅山川3ダム)', async () => {
    const html = await readFile(FIXTURE_PATH, 'utf8');
    const { rows } = parseJwaJunpoHtml(html);
    const names = rows.map((r) => r.jwaName);
    expect(names).not.toContain('上流9ダム');
    expect(names).not.toContain('銅山川3ダム');
  });

  test('returns empty rows when the fixture has no storage table', () => {
    const { rows, reportDate } = parseJwaJunpoHtml(
      '<html><body><h1>令和8年4月21日</h1><p>no table here</p></body></html>',
    );
    expect(rows).toEqual([]);
    // The date header still parses even when the table is absent.
    expect(reportDate?.toISOString()).toBe('2026-04-20T15:00:00.000Z');
  });
});

describe('ensureExternalIds binds 牧尾ダム to the dam in service (#79)', () => {
  // Master rows as in production: 牧尾（元） (NDI 905, 1961) and 牧尾（再）
  // (NDI 906, 2006), both in 長野. The （元） is inserted first so it has the
  // lower id, which used to decide ties.
  const SLUGS = ['jwa-junpo-t79-makio-moto', 'jwa-junpo-t79-makio-sai'];
  const KEY = '牧尾ダム';

  async function insertDam(
    slug: string,
    name: string,
    completedYear: number,
    stamped: boolean,
  ): Promise<bigint> {
    const ids = stamped ? { 'jwa-junpo': KEY } : {};
    const rows = await sql<{ id: bigint }[]>`
      INSERT INTO dams (slug, name, pref_code, completed_year, location, external_ids)
      VALUES (${slug}, ${name}, '20', ${completedYear},
              ST_SetSRID(ST_MakePoint(137.6, 35.8), 4326)::geography, ${sql.json(ids)})
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) throw new Error('insert dam failed');
    return id;
  }

  async function stampOf(id: bigint): Promise<string | null> {
    const rows = await sql<{ k: string | null }[]>`
      SELECT external_ids->>'jwa-junpo' AS k FROM dams WHERE id = ${id}
    `;
    return rows[0]?.k ?? null;
  }

  async function boundId(): Promise<string | undefined> {
    const matches = await ensureExternalIds(() => {});
    return matches.find((m) => m.jwaName === KEY)?.damId.toString();
  }

  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });

  test('an unstamped pair binds the completed （再）, not the lower-id （元）', async () => {
    const moto = await insertDam(SLUGS[0] as string, '牧尾（元）', 1961, false);
    const sai = await insertDam(SLUGS[1] as string, '牧尾（再）', 2006, false);

    expect(await boundId()).toBe(sai.toString());
    expect(await stampOf(sai)).toBe(KEY);
    expect(await stampOf(moto)).toBeNull();
  });

  test('a copy of the stamp on the （元） is taken off', async () => {
    const moto = await insertDam(SLUGS[0] as string, '牧尾（元）', 1961, true);
    const sai = await insertDam(SLUGS[1] as string, '牧尾（再）', 2006, true);

    expect(await boundId()).toBe(sai.toString());
    expect(await stampOf(sai)).toBe(KEY);
    expect(await stampOf(moto)).toBeNull();
  });
});
