// apps/worker/src/tasks/ingest_jwa_biwako.test.ts
//
// Fixture is a verbatim capture (UTF-8 with BOM) of
// http://www.biwako-mizukanri.jp/daminfo1_h.json, the data behind the 水資源機構
// 琵琶湖総合管理所 堰諸量 1時間表示 page, taken 2026-09-27 21:38 JST. 25 hourly
// rows, oldest first: 2026-09-26 21:00 … 2026-09-27 21:00. Per daminfo1_h.html
// ana0 = 琵琶湖 河川水位 [m, B.S.L.], ana1 = 総流入量, ana2 = 総流出量,
// ana3 = 洗堰全放流量 [m³/s].

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseBiwakoDamInfo } from './ingest_jwa_biwako.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_biwako/daminfo1_h_2026-09-27.json',
);

async function fixtureText(): Promise<string> {
  return new TextDecoder('utf-8').decode(await readFile(FIXTURE));
}

describe('parseBiwakoDamInfo', () => {
  test('reads all 25 hourly rows with JST timestamps', async () => {
    const rows = parseBiwakoDamInfo(await fixtureText());
    expect(rows).toHaveLength(25);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-09-26T12:00:00.000Z');
    expect(rows[24]?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('converts the B.S.L. lake level to T.P. elevation', async () => {
    // B.S.L. ±0 = T.P. +84.371 m; the fixture reads B.S.L. -0.33 m.
    const latest = parseBiwakoDamInfo(await fixtureText()).at(-1);
    expect(latest?.waterLevelM).toBeCloseTo(84.041, 6);
  });

  test('takes the lake total inflow and total outflow, not the 洗堰 release', async () => {
    const rows = parseBiwakoDamInfo(await fixtureText());
    const latest = rows.at(-1);
    expect(latest?.inflowM3s).toBe(107.9);
    expect(latest?.outflowM3s).toBe(84.61);
    const midnight = rows.find((r) => r.observedAt.toISOString() === '2026-09-26T15:00:00.000Z');
    expect(midnight?.inflowM3s).toBe(92.78);
    expect(midnight?.outflowM3s).toBe(86.19);
  });

  test('maps blank or non-numeric cells to null and drops rows without a time', async () => {
    const text = (await fixtureText())
      .replace(
        '"ana0":"-0.33","ana0dir":"","ana1":"107.90"',
        '"ana0":"欠測","ana0dir":"","ana1":""',
      )
      .replace('"datestr":"2026-09-26 21:00"', '"datestr":""');
    const rows = parseBiwakoDamInfo(text);
    expect(rows).toHaveLength(24);
    const latest = rows.at(-1);
    expect(latest?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
    expect(latest?.waterLevelM).toBeNull();
    expect(latest?.inflowM3s).toBeNull();
    expect(latest?.outflowM3s).toBe(84.61);
  });
});
