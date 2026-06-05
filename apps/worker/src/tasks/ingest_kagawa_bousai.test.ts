import { describe, expect, test } from 'bun:test';
import { parseKagawaItems, parseKagawaTimestamp } from './ingest_kagawa_bousai.ts';

describe('parseKagawaTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseKagawaTimestamp('2026/06/05 21:00');
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseKagawaTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseKagawaTimestamp('')).toBeNull();
    expect(parseKagawaTimestamp('bad')).toBeNull();
    expect(parseKagawaTimestamp('2026/06/05')).toBeNull();
  });
});

const SAMPLE_JSON = {
  result: 0,
  ret_time: '2026/06/05 21:07',
  items: [
    {
      station_name: '内場ダム',
      obs_datetime: '2026/06/05 21:00',
      store: 257.95,
      inflow: 1.33,
      discharge: 2.08,
      stored: 7147,
      storage_rate: 96.5,
    },
    {
      station_name: '野口ダム',
      obs_datetime: '2026/06/05 21:00',
      store: 252.49,
      inflow: 0.61,
      discharge: null,
      stored: 932,
      storage_rate: null,
    },
    {
      // Test storage_rate > 100 clamping
      station_name: '内海ダム',
      obs_datetime: '2026/06/05 21:00',
      store: 70.15,
      inflow: 0.74,
      discharge: 0.71,
      stored: 352,
      storage_rate: 102.4,
    },
  ],
};

describe('parseKagawaItems', () => {
  test('returns 3 rows', () => {
    const rows = parseKagawaItems(SAMPLE_JSON);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kagawaName)).toEqual(['内場ダム', '野口ダム', '内海ダム']);
  });

  test('observedAt converted from JST to UTC', () => {
    const rows = parseKagawaItems(SAMPLE_JSON);
    for (const r of rows) {
      expect(r.observedAt?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    }
  });

  test('内場ダム: all fields parsed correctly', () => {
    const r = parseKagawaItems(SAMPLE_JSON).find((x) => x.kagawaName === '内場ダム');
    expect(r).toBeDefined();
    expect(r?.storageRate).toBeCloseTo(0.965);
    expect(r?.storageVolumeM3).toBeCloseTo(7_147_000);
    expect(r?.waterLevelM).toBeCloseTo(257.95);
    expect(r?.inflowM3s).toBeCloseTo(1.33);
    expect(r?.outflowM3s).toBeCloseTo(2.08);
  });

  test('野口ダム: null discharge and storage_rate → null', () => {
    const r = parseKagawaItems(SAMPLE_JSON).find((x) => x.kagawaName === '野口ダム');
    expect(r).toBeDefined();
    expect(r?.outflowM3s).toBeNull();
    expect(r?.storageRate).toBeNull();
    expect(r?.storageVolumeM3).toBeCloseTo(932_000);
  });

  test('内海ダム: storage_rate > 100% clamped to 1.0', () => {
    const r = parseKagawaItems(SAMPLE_JSON).find((x) => x.kagawaName === '内海ダム');
    expect(r).toBeDefined();
    expect(r?.storageRate).toBe(1);
  });

  test('returns empty array for empty items', () => {
    expect(parseKagawaItems({ items: [] })).toHaveLength(0);
    expect(parseKagawaItems({})).toHaveLength(0);
  });
});
