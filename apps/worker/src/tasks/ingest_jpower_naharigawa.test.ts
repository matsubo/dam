// apps/worker/src/tasks/ingest_jpower_naharigawa.test.ts
//
// Fixtures are verbatim UTF-8 captures of J-POWER 奈半利川ダム情報公開サイト
// ダムグラフ pages (https://jpower-naharigawa-daminfo.jp/Pages/DamGraph01.aspx,
// default 30分 view), taken 2026-09-28 15:52–15:53 JST:
//   damgraph_{71100,71200,71300}_2026-09-28T16.html — ?value=2026/09/28 16:00
//     for 魚梁瀬 / 久木 / 平鍋: 09/28 10:30 … 16:00, the 16:00 column still
//     blank (requested before it was observed).
//   damgraph_71100_2026-01-01T01.html — ?value=2026/01/01 01:00 for 魚梁瀬:
//     12/31 19:30 … 24:00, 01/01 00:30, 01:00 (a year boundary).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, graphValue, parseNaharigawaGraph } from './ingest_jpower_naharigawa.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/jpower_naharigawa');

async function fixture(name: string): Promise<string> {
  return readFile(join(DIR, name), 'utf8');
}

describe('parseNaharigawaGraph', () => {
  test('reads the dam name the page shows', async () => {
    expect(parseNaharigawaGraph(await fixture('damgraph_71100_2026-09-28T16.html')).name).toBe(
      '魚梁瀬ダム',
    );
    expect(parseNaharigawaGraph(await fixture('damgraph_71200_2026-09-28T16.html')).name).toBe(
      '久木ダム',
    );
    expect(parseNaharigawaGraph(await fixture('damgraph_71300_2026-09-28T16.html')).name).toBe(
      '平鍋ダム',
    );
  });

  test('reads every half-hour column, JST converted to UTC', async () => {
    const { readings } = parseNaharigawaGraph(await fixture('damgraph_71100_2026-09-28T16.html'));
    expect(readings[0]).toEqual({
      observedAt: new Date('2026-09-28T01:30:00Z'),
      waterLevelM: 429.35,
      inflowM3s: 14,
      outflowM3s: 14,
    });
    // 15:30 JST: the back-calculated inflow is published negative; kept as is.
    expect(readings.at(-1)).toEqual({
      observedAt: new Date('2026-09-28T06:30:00Z'),
      waterLevelM: 429.33,
      inflowM3s: -11,
      outflowM3s: 2,
    });
  });

  test('drops a column with no level, inflow or outflow', async () => {
    const { readings } = parseNaharigawaGraph(await fixture('damgraph_71100_2026-09-28T16.html'));
    // 12 columns 10:30 … 16:00; the not-yet-observed 16:00 one is blank.
    expect(readings).toHaveLength(11);
    expect(readings.map((r) => r.observedAt.toISOString())).not.toContain(
      '2026-09-28T07:00:00.000Z',
    );
  });

  test('takes each dam its own rows', async () => {
    const kuki = parseNaharigawaGraph(await fixture('damgraph_71200_2026-09-28T16.html'));
    expect(kuki.readings[0]).toEqual({
      observedAt: new Date('2026-09-28T01:30:00Z'),
      waterLevelM: 343.39,
      inflowM3s: 19,
      outflowM3s: 12,
    });
    const hiranabe = parseNaharigawaGraph(await fixture('damgraph_71300_2026-09-28T16.html'));
    expect(hiranabe.readings.at(-1)).toEqual({
      observedAt: new Date('2026-09-28T06:30:00Z'),
      waterLevelM: 145.05,
      inflowM3s: 35,
      outflowM3s: 28,
    });
  });

  test('dates 12/31 in the year before the page year, and 24:00 as the next midnight', async () => {
    const { readings } = parseNaharigawaGraph(await fixture('damgraph_71100_2026-01-01T01.html'));
    expect(readings).toHaveLength(12);
    const at = readings.map((r) => r.observedAt.toISOString());
    expect(at[0]).toBe('2025-12-31T10:30:00.000Z'); // 12/31 19:30 JST
    expect(at[9]).toBe('2025-12-31T15:00:00.000Z'); // 12/31 24:00 JST
    expect(at[10]).toBe('2025-12-31T15:30:00.000Z'); // 01/01 00:30 JST
    expect(at[11]).toBe('2025-12-31T16:00:00.000Z'); // 01/01 01:00 JST
    expect(readings[9]?.waterLevelM).toBe(415.47);
    expect(readings[9]?.inflowM3s).toBe(10);
  });

  test('reads a non-numeric cell as null and keeps the column', async () => {
    const html = (await fixture('damgraph_71100_2026-09-28T16.html')).replace(
      '<td class="tableData">&nbsp;14.00</td>',
      '<td class="tableData">欠測</td>',
    );
    const { readings } = parseNaharigawaGraph(html);
    expect(readings).toHaveLength(11);
    expect(readings[0]).toEqual({
      observedAt: new Date('2026-09-28T01:30:00Z'),
      waterLevelM: 429.35,
      inflowM3s: null,
      outflowM3s: 14,
    });
  });

  test('returns no readings for a page without the table', () => {
    expect(parseNaharigawaGraph('<html></html>')).toEqual({ name: null, readings: [] });
  });
});

describe('graphValue', () => {
  test('asks for the JST hour now running, so its :30 column is included', () => {
    expect(graphValue(new Date('2026-09-28T06:52:00Z'))).toBe('2026/09/28 16:00');
  });

  test('keeps an exact hour as is', () => {
    expect(graphValue(new Date('2026-09-28T06:00:00Z'))).toBe('2026/09/28 15:00');
  });

  test('writes JST midnight as 24:00 of the day before, the way the page does', () => {
    expect(graphValue(new Date('2026-09-28T14:40:00Z'))).toBe('2026/09/28 24:00');
    expect(graphValue(new Date('2025-12-31T15:00:00Z'))).toBe('2025/12/31 24:00');
  });
});

describe('chooseMaster', () => {
  const m = (id: number, name: string, stamp: string | null = null) => ({
    id: BigInt(id),
    name,
    completedYear: null,
    stamp,
  });
  // Real pref-39 rows (prod, 2026-09-28): 魚梁瀬 (NDI 2080), 久木 (2081),
  // 平鍋 (2082), all 電源開発.
  const masters = [m(10359, '魚梁瀬'), m(10360, '久木'), m(10361, '平鍋')];

  test('binds each published dam to its own master row', () => {
    expect(chooseMaster('魚梁瀬ダム', masters)).toBe(10359n);
    expect(chooseMaster('久木ダム', masters)).toBe(10360n);
    expect(chooseMaster('平鍋ダム', masters)).toBe(10361n);
  });

  test('leaves a station unbound rather than fall back to a prefix hit', () => {
    expect(chooseMaster('久木ダム', [m(1, '久木野')])).toBeNull();
  });

  test('keeps the row already stamped with the station', () => {
    expect(chooseMaster('平鍋ダム', [m(10361, '平鍋'), m(99, '平鍋', '平鍋ダム')])).toBe(99n);
  });
});
