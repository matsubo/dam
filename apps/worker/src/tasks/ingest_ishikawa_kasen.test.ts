// apps/worker/src/tasks/ingest_ishikawa_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import {
  buildUrl,
  parseIshikawaJson,
  parseIshikawaTimestamp,
} from './ingest_ishikawa_kasen.ts';

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
    const url = buildUrl(new Date('2026-06-05T17:00:00.000Z'), 'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline');
    expect(url).toBe(
      'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline/20260606/20260606_1_dam_60.json',
    );
  });

  test('uses JST date (before midnight UTC maps to previous JST date)', () => {
    // 2026-06-05 08:00 UTC = 2026-06-05 17:00 JST → date 20260605
    const url = buildUrl(new Date('2026-06-05T08:00:00.000Z'), 'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline');
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
  // 手取川ダム(国) should be excluded (not in STATION_MAP)
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

describe('parseIshikawaJson', () => {
  test('parses 3 dam rows (手取川(国) excluded)', () => {
    const rows = parseIshikawaJson(SAMPLE_JSON);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.ishikawaName)).toEqual(['八ヶ川ダム', '新内川ダム', '大日川ダム']);
  });

  test('all rows share the same observedAt (2026-06-05T08:00Z)', () => {
    const rows = parseIshikawaJson(SAMPLE_JSON);
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe('2026-06-05T08:00:00.000Z');
    }
  });

  test('八ヶ川ダム: all fields parsed correctly', () => {
    const r = parseIshikawaJson(SAMPLE_JSON).find((x) => x.ishikawaName === '八ヶ川ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(130.6);
    expect(r?.storageVolumeM3).toBe(958_000);
    expect(r?.inflowM3s).toBeCloseTo(0.21);
    expect(r?.outflowM3s).toBeCloseTo(0.21);
  });

  test('新内川ダム: "*" inflow and storage → null; outflow and level present', () => {
    const r = parseIshikawaJson(SAMPLE_JSON).find((x) => x.ishikawaName === '新内川ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(104.99);
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeCloseTo(1.33);
  });

  test('大日川ダム: comma-separated storage parsed and converted to m³', () => {
    const r = parseIshikawaJson(SAMPLE_JSON).find((x) => x.ishikawaName === '大日川ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBe(17_634_000);
    expect(r?.inflowM3s).toBeCloseTo(3.74);
  });

  test('手取川ダム(国) excluded from results', () => {
    const rows = parseIshikawaJson(SAMPLE_JSON);
    expect(rows.find((r) => r.ishikawaName.includes('手取川'))).toBeUndefined();
  });

  test('returns empty array for empty JSON', () => {
    expect(parseIshikawaJson({ observationTime: '2026-06-05-17-00' })).toHaveLength(0);
  });
});
