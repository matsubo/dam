// apps/worker/src/tasks/ingest_fukushima_kasen.test.ts
//
// Feed → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  buildFukushimaUrl,
  fukushimaEntries,
  parseFukushimaTimestamp,
} from './ingest_fukushima_kasen.ts';

function observed(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}
const state = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('parseFukushimaTimestamp', () => {
  test('parses "YYYY-MM-DD-HH-mm" (JST) → UTC', () => {
    const d = parseFukushimaTimestamp('2026-06-05-20-00');
    expect(d?.toISOString()).toBe('2026-06-05T11:00:00.000Z');
    expect(d?.getUTCHours()).toBe(11);
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseFukushimaTimestamp('2026-06-05-00-00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseFukushimaTimestamp('')).toBeNull();
    expect(parseFukushimaTimestamp('2026-06-05')).toBeNull();
    expect(parseFukushimaTimestamp('bad')).toBeNull();
  });
});

describe('buildFukushimaUrl', () => {
  test('generates correct URL from UTC time (JST date)', () => {
    // 2026-06-05 17:00 UTC = 2026-06-06 02:00 JST → date 20260606
    const url = buildFukushimaUrl(
      new Date('2026-06-05T17:00:00.000Z'),
      'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc',
    );
    expect(url).toBe(
      'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc/20260606/20260606_1_dam_60.json',
    );
  });

  test('uses JST date (UTC morning maps to same JST date)', () => {
    // 2026-06-05 08:00 UTC = 2026-06-05 17:00 JST → date 20260605
    const url = buildFukushimaUrl(
      new Date('2026-06-05T08:00:00.000Z'),
      'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc',
    );
    expect(url).toBe(
      'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc/20260605/20260605_1_dam_60.json',
    );
  });
});

// Sample JSON — 3 dam stations + 1 non-dam station.
const SAMPLE_JSON = {
  observationTime: '2026-06-05-20-00',
  updateTime: '2026-06-05-20-27',
  // 小玉ダム: all fields present
  '1795_7_3': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { val: '184.46', lvl: 0 },
        item_50: { val: '1.31', lvl: 0 },
        item_70: { val: '1.13', lvl: 0 },
        item_1_70: { val: '0.0', lvl: 0 },
      },
    ],
  },
  // 四時ダム: missing rainfall
  '1795_7_2': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { val: '102.48', lvl: 0 },
        item_50: { val: '0.98', lvl: 0 },
        item_70: { val: '0.98', lvl: 0 },
      },
    ],
  },
  // 高柴ダム: inflow and outflow null ("**")
  '1795_7_1': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { val: '53.47', lvl: 0 },
        item_50: { val: '**', lvl: 0 },
        item_70: { val: '**', lvl: 0 },
        item_1_70: { val: '0.0', lvl: 0 },
      },
    ],
  },
  // 十六橋水門: 猪苗代湖's outlet gate — listed, never bound
  '1799_7_3': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { val: '513.44', lvl: 0 },
        item_50: { val: '24.97', lvl: 0 },
        item_70: { val: '14.67', lvl: 0 },
      },
    ],
  },
};

describe('fukushimaEntries', () => {
  const entries = fukushimaEntries(SAMPLE_JSON);
  const named = (n: string) => entries.find((e) => e.name === n);

  test('the whole catalogue: 11 dams and 4 non-dam stations, keyed by station id', () => {
    expect(entries).toHaveLength(15);
    expect(named('小玉ダム')?.key).toBe('1795_7_3');
    expect(named('小玉ダム')?.pref).toBe('07');
    expect(named('小玉ダム')?.bind).toBeUndefined();
    expect(entries.filter((e) => e.bind === 'never').map((e) => [e.key, e.name, state(e)])).toEqual(
      [
        ['1799_7_21', '桧原湖', 'unreadable'],
        ['1799_7_22', '小野川湖', 'unreadable'],
        ['1799_7_23', '秋元湖', 'unreadable'],
        ['1799_7_3', '十六橋水門', 'values'],
      ],
    );
  });

  test('a station absent from the feed is unreadable, never dropped', () => {
    expect(state(named('こまちダム'))).toBe('unreadable');
    expect(entries.filter((e) => state(e) === 'values').map((e) => e.name)).toEqual([
      '小玉ダム',
      '高柴ダム',
      '四時ダム',
      '十六橋水門',
    ]);
  });

  test('all rows share the same observedAt (2026-06-05T11:00Z)', () => {
    for (const n of ['小玉ダム', '高柴ダム', '四時ダム']) {
      expect(observed(named(n))?.observedAt.toISOString()).toBe('2026-06-05T11:00:00.000Z');
    }
  });

  test('小玉ダム: all fields including rainfall parsed correctly', () => {
    const r = observed(named('小玉ダム'));
    expect(r?.waterLevelM).toBeCloseTo(184.46);
    expect(r?.inflowM3s).toBeCloseTo(1.31);
    expect(r?.outflowM3s).toBeCloseTo(1.13);
    expect(r?.rainfallMm).toBeCloseTo(0.0);
  });

  test('四時ダム: missing rainfall → null', () => {
    const r = observed(named('四時ダム'));
    expect(r?.waterLevelM).toBeCloseTo(102.48);
    expect(r?.rainfallMm).toBeNull();
  });

  test('高柴ダム: "**" inflow/outflow → null; waterLevel still included', () => {
    const r = observed(named('高柴ダム'));
    expect(r?.waterLevelM).toBeCloseTo(53.47);
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
  });

  test('"*" on every item is provider-marked empty', () => {
    const json = {
      '1795_7_3': {
        data60: [
          {
            time: '2026-06-05-20-00',
            item_10: { val: '*' },
            item_50: { val: '*' },
            item_70: { val: '--' },
            item_1_70: { val: '**' },
          },
        ],
      },
    };
    expect(state(fukushimaEntries(json).find((e) => e.key === '1795_7_3'))).toBe('empty');
  });

  test('a feed that could not be fetched leaves every station unreadable', () => {
    const list = fukushimaEntries(null, 'HTTP 404');
    expect(list).toHaveLength(15);
    expect(new Set(list.map(state))).toEqual(new Set(['unreadable']));
  });
});
