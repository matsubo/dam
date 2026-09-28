// apps/worker/src/tasks/ingest_jwa_kiso_rt.test.ts
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 中部支社 リアルタイム情報
// 木曽川水系 (water.go.jp/mizu/chubu/realtime/index.html) taken 2026-09-28
// 12:54 JST, 観測時刻 2026年09月28日 12時40分. Page order: 牧尾, 味噌川,
// 阿木川, 岩屋, 徳山, 打上調整池 (貯水位 only), 中里貯水池 (貯水位 and
// 有効貯水量 only), 宮川/菰野/加佐登調整池, then 長良川河口堰 (流入量 193.44,
// 流出量 214.77) and 木曽川大堰 (流入量 542.99, 放流量 535.39).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '@dam/db/client';
import { ensureExternalIds, parseKisoRtHtml, parseKisoRtTimestamp } from './ingest_jwa_kiso_rt.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_kiso_rt/index_2026-09-28.html',
);

describe('parseKisoRtTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseKisoRtTimestamp('観測時刻：2026年06月05日 10時10分');
    expect(d).not.toBeNull();
    // 10:10 JST = 01:10 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T01:10:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 wraps to previous UTC day)', () => {
    const d = parseKisoRtTimestamp('観測時刻：2026年06月05日 08時00分');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → JS Date normalizes to 23:00 UTC previous day
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null when no timestamp present', () => {
    expect(parseKisoRtTimestamp('no timestamp here')).toBeNull();
  });
});

describe('parseKisoRtHtml on the live page', () => {
  test('reads each dam from its own table only', async () => {
    const { observedAt, rows } = parseKisoRtHtml(await readFile(FIXTURE, 'utf8'));
    expect(observedAt?.toISOString()).toBe('2026-09-28T03:40:00.000Z');
    // 中里's table has no 流入量 / 放流量. The 193.44 and 535.39 further down
    // the page belong to 長良川河口堰 and 木曽川大堰.
    expect(rows).toEqual([
      {
        kisoName: '牧尾ダム',
        waterLevelM: 877.75,
        storageVolumeM3: 60_877_000,
        inflowM3s: 375.6,
        outflowM3s: 392.78,
      },
      {
        kisoName: '味噌川ダム',
        waterLevelM: 1112.78,
        storageVolumeM3: 42_739_000,
        inflowM3s: 12.6,
        outflowM3s: 10.81,
      },
      {
        kisoName: '阿木川ダム',
        waterLevelM: 399.9,
        storageVolumeM3: 27_284_000,
        inflowM3s: 18.53,
        outflowM3s: 21.8,
      },
      {
        kisoName: '岩屋ダム',
        waterLevelM: 409.84,
        storageVolumeM3: 96_026_000,
        inflowM3s: 94.73,
        outflowM3s: 0,
      },
      {
        kisoName: '徳山ダム',
        waterLevelM: 382.03,
        storageVolumeM3: 160_488_000,
        inflowM3s: 18.25,
        outflowM3s: 18.25,
      },
      {
        kisoName: '中里貯水池',
        waterLevelM: 172.52,
        storageVolumeM3: 1_801_000,
        inflowM3s: null,
        outflowM3s: null,
      },
    ]);
  });

  test('an empty data cell is null, not the next row of the table', async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace('>375.60<', '><');
    const makio = parseKisoRtHtml(html).rows.find((r) => r.kisoName === '牧尾ダム');
    expect(makio?.inflowM3s).toBeNull();
    expect(makio?.outflowM3s).toBe(392.78);
  });
});

describe('parseKisoRtHtml', () => {
  // Mirrors the actual page structure: <h4>NAME</h4> followed by <td class="data">VALUE<span...
  const makeDamSection = (
    name: string,
    level: string,
    storage: string,
    inflow?: string,
    outflow?: string,
  ): string => {
    const inRow =
      inflow !== undefined
        ? `<tr><th>流入量</th><td class="data">${inflow}<span class="unit">m3/s</span></td></tr>`
        : '';
    const outRow =
      outflow !== undefined
        ? `<tr><th>放流量</th><td class="data">${outflow}<span class="unit">m3/s</span></td></tr>`
        : '';
    return `<h4>${name}</h4><table><tbody>
<tr><th>貯水位</th><td class="data">${level}<span class="unit">EL.m</span></td></tr>
<tr><th>有効貯水量</th><td class="data">${storage}<span class="unit">103m3</span></td></tr>
${inRow}${outRow}</tbody></table>`;
  };

  const makeHtml = (body: string): string =>
    `<html><body><span class="latest-time">2026年06月05日 10時10分</span>${body}</body></html>`;

  test('treats "cc" sensor values as null; skips dam when both primary metrics are cc', () => {
    const html = makeHtml(
      makeDamSection('阿木川ダム', 'cc', 'cc', 'cc', 'cc') +
        makeDamSection('岩屋ダム', '402.91', '74053', '16.59', '0.00'),
    );
    const { rows } = parseKisoRtHtml(html);
    // 阿木川 skipped (both waterLevel and storage null); 岩屋 remains
    expect(rows.find((r) => r.kisoName === '阿木川ダム')).toBeUndefined();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kisoName).toBe('岩屋ダム');
  });

  test('dam with cc water level but valid storage is kept', () => {
    const html = makeHtml(makeDamSection('牧尾ダム', 'cc', '55707', '5.51', '0.00'));
    const { rows } = parseKisoRtHtml(html);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waterLevelM).toBeNull();
    expect(rows[0]?.storageVolumeM3).toBe(55707000);
  });

  test('skips unknown dam names', () => {
    const html = makeHtml(makeDamSection('謎ダム', '100.00', '5000', '1.00', '0.50'));
    const { rows } = parseKisoRtHtml(html);
    expect(rows).toHaveLength(0);
  });

  test('returns null observedAt when no timestamp in HTML', () => {
    const html = `<div>${makeDamSection('牧尾ダム', '875.63', '55707', '5.51', '0.00')}</div>`;
    const { observedAt, rows } = parseKisoRtHtml(html);
    expect(observedAt).toBeNull();
    expect(rows).toHaveLength(1); // still parses dam data
  });
});

describe('ensureExternalIds binds 中里貯水池 to 三重用水 in 三重県', () => {
  // 中里貯水池 is 三重用水's reservoir (いなべ市, NDI 940; the jwa-chubu report
  // prints its 利水容量 16,000 千m³ = the master's 有効). Migration 0031 had
  // invented a 長野 '中里' for it, which carried the stamp on prod. Synthetic
  // rows: the 三重 master and a stamped 長野 namesake.
  const SLUGS = ['jwa-kiso-rt-t-nakazato-mie', 'jwa-kiso-rt-t-nakazato-nagano'];
  const KEY = '中里貯水池';

  async function insertDam(slug: string, prefCode: string, stamped: boolean): Promise<bigint> {
    const ids = stamped ? { 'jwa-kiso-rt': KEY } : {};
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
      SELECT external_ids->>'jwa-kiso-rt' AS k FROM dams WHERE id = ${id}
    `;
    return rows[0]?.k ?? null;
  }

  // ensureExternalIds records the jwa-kiso-rt universe; remove only the rows
  // this file created, never ones that were already there.
  let universeBefore: string[] = [];
  let runBefore = false;
  beforeAll(async () => {
    const rows = await sql<{ k: string }[]>`
      SELECT source_external_id AS k FROM source_universe WHERE source_id = 'jwa-kiso-rt'
    `;
    universeBefore = rows.map((r) => r.k);
    const runs = await sql`SELECT 1 FROM source_universe_runs WHERE source_id = 'jwa-kiso-rt'`;
    runBefore = runs.length > 0;
  });
  beforeEach(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
  });
  afterAll(async () => {
    await sql`DELETE FROM dams WHERE slug = ANY(${SLUGS})`;
    await sql`
      DELETE FROM source_universe
      WHERE source_id = 'jwa-kiso-rt' AND NOT (source_external_id = ANY(${universeBefore}))
    `;
    if (!runBefore) await sql`DELETE FROM source_universe_runs WHERE source_id = 'jwa-kiso-rt'`;
  });

  test('the 三重 row wins over a 長野 namesake that holds the stamp', async () => {
    const mie = await insertDam(SLUGS[0] as string, '24', false);
    const nagano = await insertDam(SLUGS[1] as string, '20', true);

    const matches = await ensureExternalIds(() => {});

    expect(matches.find((m) => m.kisoName === KEY)?.damId.toString()).toBe(mie.toString());
    expect(await stampOf(mie)).toBe(KEY);
    expect(await stampOf(nagano)).toBeNull();
    const [u] = await sql<{ prefCode: string | null }[]>`
      SELECT pref_code AS "prefCode" FROM source_universe
      WHERE source_id = 'jwa-kiso-rt' AND source_external_id = ${KEY}
    `;
    expect(u?.prefCode).toBe('24');
  });
});
