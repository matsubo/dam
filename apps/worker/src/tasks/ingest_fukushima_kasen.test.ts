import { describe, expect, test } from 'bun:test';
import {
  buildFukushimaUrl,
  parseFukushimaJson,
  parseFukushimaTimestamp,
} from './ingest_fukushima_kasen.ts';

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

// Sample JSON — 3 dam stations + 1 excluded lake.
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
  // 桧原湖: natural lake — excluded (not in STATION_MAP)
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

describe('parseFukushimaJson', () => {
  test('parses 3 dam rows (桧原湖 excluded)', () => {
    const rows = parseFukushimaJson(SAMPLE_JSON);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.fukushimaName)).toEqual(['小玉ダム', '高柴ダム', '四時ダム']);
  });

  test('all rows share the same observedAt (2026-06-05T11:00Z)', () => {
    const rows = parseFukushimaJson(SAMPLE_JSON);
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe('2026-06-05T11:00:00.000Z');
    }
  });

  test('小玉ダム: all fields including rainfall parsed correctly', () => {
    const r = parseFukushimaJson(SAMPLE_JSON).find((x) => x.fukushimaName === '小玉ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(184.46);
    expect(r?.inflowM3s).toBeCloseTo(1.31);
    expect(r?.outflowM3s).toBeCloseTo(1.13);
    expect(r?.rainfallMm).toBeCloseTo(0.0);
  });

  test('四時ダム: missing rainfall → null', () => {
    const r = parseFukushimaJson(SAMPLE_JSON).find((x) => x.fukushimaName === '四時ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(102.48);
    expect(r?.rainfallMm).toBeNull();
  });

  test('高柴ダム: "**" inflow/outflow → null; waterLevel still included', () => {
    const r = parseFukushimaJson(SAMPLE_JSON).find((x) => x.fukushimaName === '高柴ダム');
    expect(r).toBeDefined();
    expect(r?.waterLevelM).toBeCloseTo(53.47);
    expect(r?.inflowM3s).toBeNull();
    expect(r?.outflowM3s).toBeNull();
  });

  test('桧原湖 excluded (not in STATION_MAP)', () => {
    const rows = parseFukushimaJson(SAMPLE_JSON);
    expect(rows.find((r) => r.fukushimaName.includes('桧原'))).toBeUndefined();
  });

  test('returns empty array for empty JSON', () => {
    expect(parseFukushimaJson({ observationTime: '2026-06-05-20-00' })).toHaveLength(0);
  });
});
