// apps/worker/src/tasks/ingest_ibaraki_kasumigaura.test.ts
//
// Fixture is a verbatim capture (Shift_JIS) of 茨城県河川情報
// pc/graph/gra_river_372_1.html — 霞ヶ浦 出島 水位グラフ — taken 2026-09-28
// 15:58 JST (Last-Modified 15:52). Header 「2026年 09月28日 16：00 現在」, 零点高
// T.P.-0.96m, 24 hourly rows 09/27 17:00 … 09/28 15:00 (with 24:00 between
// 23:00 and 09/28 01:00) plus the latest 10-minute row 15:50 (1.51 m).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDejimaGraph } from './ingest_ibaraki_kasumigaura.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/ibaraki_kasumigaura/gra_river_372_2026-09-28T1550.html',
);

async function fixture(): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
}

describe('parseDejimaGraph', () => {
  test('dates every row in JST, 24:00 as the next day and the 10-minute row last', async () => {
    const r = parseDejimaGraph(await fixture());
    const at = r?.readings.map((x) => x.observedAt.toISOString()) ?? [];
    expect(at).toHaveLength(24);
    expect(at[0]).toBe('2026-09-27T08:00:00.000Z'); // 09/27 17:00
    expect(at[7]).toBe('2026-09-27T15:00:00.000Z'); // 24:00 = 09/28 00:00
    expect(at[8]).toBe('2026-09-27T16:00:00.000Z'); // 09/28 01:00
    expect(at[23]).toBe('2026-09-28T06:50:00.000Z'); // 15:50
  });

  test('stores the lake level on Y.P., from the gauge reading and the printed 零点高', async () => {
    const r = parseDejimaGraph(await fixture());
    expect(r?.zeroTpM).toBe(-0.96);
    // 1.51 − 0.96 (T.P.) + 0.8402 (Y.P. = T.P. + 0.8402 m) = 1.3902
    expect(r?.readings.at(-1)?.waterLevelM).toBe(1.39);
    // 09/27 17:00 read 1.59 → 1.4702
    expect(r?.readings[0]?.waterLevelM).toBe(1.47);
  });

  test('a missing reading drops that row only', async () => {
    const html = (await fixture()).replace(
      '<td nowrap="" class="r2">&nbsp;&nbsp;&nbsp;&nbsp;1.51</td>',
      '<td nowrap="" class="r2">&nbsp;&nbsp;&nbsp;&nbsp;欠測</td>',
    );
    const r = parseDejimaGraph(html);
    expect(r?.readings).toHaveLength(23);
    expect(r?.readings.at(-1)?.observedAt.toISOString()).toBe('2026-09-28T06:00:00.000Z');
  });

  test('rows before a 1月1日 header belong to the previous year', async () => {
    const html = (await fixture())
      .replace('2026年&nbsp;09月28日', '2027年&nbsp;01月01日')
      .replace('09/27&nbsp;&nbsp;17:00', '12/31&nbsp;&nbsp;17:00')
      .replace('09/28&nbsp;&nbsp;01:00', '01/01&nbsp;&nbsp;01:00');
    const at = parseDejimaGraph(html)?.readings.map((x) => x.observedAt.toISOString()) ?? [];
    expect(at[0]).toBe('2026-12-31T08:00:00.000Z');
    expect(at[8]).toBe('2026-12-31T16:00:00.000Z');
    expect(at[23]).toBe('2027-01-01T06:50:00.000Z');
  });

  test('refuses a page without 零点高: a bare gauge height has no datum', async () => {
    const html = (await fixture()).replace('T.P.-0.96m', '');
    expect(parseDejimaGraph(html)).toBeNull();
  });

  test('refuses a page for another station', async () => {
    const html = (await fixture()).replace('<td>出島</td>', '<td>白浜</td>');
    expect(parseDejimaGraph(html)).toBeNull();
  });
});
