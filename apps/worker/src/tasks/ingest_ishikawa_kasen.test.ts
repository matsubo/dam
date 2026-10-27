// apps/worker/src/tasks/ingest_ishikawa_kasen.test.ts
//
// Feed → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { buildUrl, ishikawaEntries, parseIshikawaTimestamp } from './ingest_ishikawa_kasen.ts';

function observed(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}
const state = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

describe('parseIshikawaTimestamp', () => {
  test('parses "YYYY-MM-DD-HH-mm" (JST) → UTC', () => {
    const d = parseIshikawaTimestamp('2026-06-05-17-00');
    expect(d?.toISOString()).toBe('2026-06-05T08:00:00.000Z');
  });

  test('handles midnight crossover (JST 01:00 → previous UTC day)', () => {
    const d = parseIshikawaTimestamp('2026-06-05-01-00');
    expect(d?.toISOString()).toBe('2026-06-04T16:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseIshikawaTimestamp('')).toBeNull();
    expect(parseIshikawaTimestamp('2026-06-05')).toBeNull();
    expect(parseIshikawaTimestamp('bad')).toBeNull();
  });
});

describe('buildUrl', () => {
  test('generates correct URL from UTC time (JST date)', () => {
    // 2026-06-05 17:00 UTC = 2026-06-06 02:00 JST → date 20260606
    const url = buildUrl(
      new Date('2026-06-05T17:00:00.000Z'),
      'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline',
    );
    expect(url).toBe(
      'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline/20260606/20260606_1_dam_60.json',
    );
  });

  test('uses JST date (before midnight UTC maps to previous JST date)', () => {
    // 2026-06-05 08:00 UTC = 2026-06-05 17:00 JST → date 20260605
    const url = buildUrl(
      new Date('2026-06-05T08:00:00.000Z'),
      'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline',
    );
    expect(url).toBe(
      'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline/20260605/20260605_1_dam_60.json',
    );
  });
});

// Minimal sample JSON — 3 stations covering: full data / missing inflow / all-null.
const SAMPLE_JSON = {
  observationTime: '2026-06-05-17-00',
  updateTime: '2026-06-05-17-46',
  // 八ヶ川ダム: all fields present
  '4361_7_41': {
    data60: [
      {
        time: '2026-06-05-17-00',
        item_10: { val: '130.60', lvl: 0 },
        item_20: { val: '958', lvl: 0 },
        item_50: { val: '0.21', lvl: 0 },
        item_70: { val: '0.21', lvl: 0 },
      },
    ],
  },
  // 新内川ダム: inflow and storage missing ("*")
  '4369_7_63': {
    data60: [
      {
        time: '2026-06-05-17-00',
        item_10: { val: '104.99', lvl: 0 },
        item_20: { val: '*', lvl: 0 },
        item_50: { val: '*', lvl: 0 },
        item_70: { val: '1.33', lvl: 0 },
      },
    ],
  },
  // 大日川ダム: comma-separated storage value
  '4356_7_21': {
    data60: [
      {
        time: '2026-06-05-17-00',
        item_10: { val: '325.87', lvl: 0 },
        item_20: { val: '17,634', lvl: 0 },
        item_50: { val: '3.74', lvl: 0 },
        item_70: { val: '3.76', lvl: 0 },
      },
    ],
  },
  // 手取川ダム(国): recorded, not written
  '21565_7_1': {
    data60: [
      {
        time: '2026-06-05-17-00',
        item_10: { val: '453.34', lvl: 0 },
        item_20: { val: '133,532', lvl: 0 },
        item_50: { val: '12.72', lvl: 0 },
        item_70: { val: '58.11', lvl: 0 },
      },
    ],
  },
};

describe('ishikawaEntries', () => {
  const entries = ishikawaEntries(SAMPLE_JSON);
  const named = (n: string) => entries.find((e) => e.name === n);

  test('the whole catalogue, keyed by station id; a station absent from the feed is unreadable', () => {
    expect(entries).toHaveLength(12);
    expect(named('八ヶ川ダム')?.key).toBe('4361_7_41');
    expect(named('八ヶ川ダム')?.pref).toBe('17');
    expect(entries.filter((e) => state(e) === 'values').map((e) => e.name)).toEqual([
      '八ヶ川ダム',
      '新内川ダム',
      '大日川ダム',
      '手取川ダム',
    ]);
    expect(state(named('内川ダム'))).toBe('unreadable');
  });

  test('手取川ダム(国) is recorded but never written', () => {
    expect(named('手取川ダム')?.key).toBe('21565_7_1');
    expect(named('手取川ダム')?.dontWrite).toBeDefined();
    expect(entries.filter((e) => e.dontWrite).map((e) => e.name)).toEqual(['手取川ダム']);
  });

  test('all rows share the same observedAt (2026-06-05T08:00Z)', () => {
    for (const n of ['八ヶ川ダム', '新内川ダム', '大日川ダム']) {
      expect(observed(named(n))?.observedAt.toISOString()).toBe('2026-06-05T08:00:00.000Z');
    }
  });

  test('八ヶ川ダム: all fields parsed correctly', () => {
    const r = observed(named('八ヶ川ダム'));
    expect(r?.waterLevelM).toBeCloseTo(130.6);
    expect(r?.storageVolumeM3).toBe(958_000);
    expect(r?.inflowM3s).toBeCloseTo(0.21);
    expect(r?.outflowM3s).toBeCloseTo(0.21);
  });

  test('新内川ダム: "*" inflow and storage → null; outflow and level present', () => {
    const r = observed(named('新内川ダム'));
    expect(r?.waterLevelM).toBeCloseTo(104.99);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeCloseTo(1.33);
  });

  test('大日川ダム: comma-separated storage parsed and converted to m³', () => {
    const r = observed(named('大日川ダム'));
    expect(r?.storageVolumeM3).toBe(17_634_000);
    expect(r?.inflowM3s).toBeCloseTo(3.74);
  });

  test('"*" on every item is provider-marked empty', () => {
    const json = {
      '4361_7_41': {
        data60: [
          {
            time: '2026-06-05-17-00',
            item_10: { val: '*' },
            item_20: { val: '*' },
            item_50: { val: '*' },
            item_70: { val: '*' },
          },
        ],
      },
    };
    expect(state(ishikawaEntries(json).find((e) => e.key === '4361_7_41'))).toBe('empty');
  });

  test('a feed that could not be fetched leaves every station unreadable', () => {
    const list = ishikawaEntries(null, 'HTTP 404');
    expect(list).toHaveLength(12);
    expect(new Set(list.map(state))).toEqual(new Set(['unreadable']));
  });
});
