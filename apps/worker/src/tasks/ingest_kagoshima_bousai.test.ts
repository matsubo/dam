import { describe, expect, test } from 'bun:test';
import { parseItems, parseKagoshimaTimestamp } from './ingest_kagoshima_bousai.ts';
import type { BousaiItem } from './ingest_kagoshima_bousai.ts';

describe('parseKagoshimaTimestamp', () => {
  test('parses YYYY/MM/DD HH:MM JST → UTC', () => {
    const d = parseKagoshimaTimestamp('2026/06/05 10:00');
    expect(d?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
  });

  test('handles midnight correctly (00:00 JST = -9h UTC)', () => {
    const d = parseKagoshimaTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('handles single-digit month and day', () => {
    const d = parseKagoshimaTimestamp('2026/1/5 09:30');
    expect(d?.toISOString()).toBe('2026-01-05T00:30:00.000Z');
  });

  test('returns null for invalid input', () => {
    expect(parseKagoshimaTimestamp('')).toBeNull();
    expect(parseKagoshimaTimestamp('invalid')).toBeNull();
  });
});

const SAMPLE_ITEMS: BousaiItem[] = [
  {
    station_name: '椛川ダム',
    station_no: '013707018000000000',
    point: { lon: 130.5, lat: 31.5 },
    obs_datetime: '2026/06/05 10:00',
    store: 234.56,
    stored: 1234,
    inflow: 12.3,
    discharge: 8.5,
  },
  {
    station_name: '大和ダム',
    station_no: '013707002000000000',
    point: { lon: 130.6, lat: 31.6 },
    obs_datetime: '2026/06/05 10:00',
    store: 156.78,
    stored: null,
    inflow: 5.6,
    discharge: 3.2,
  },
  {
    station_name: '川辺ダム',
    station_no: '013707010000000000',
    point: { lon: 130.3, lat: 31.3 },
    obs_datetime: '2026/06/05 10:00',
    store: null,
    stored: 567,
    inflow: null,
    discharge: null,
  },
];

describe('parseItems', () => {
  test('parses timestamp and converts stored (千m³ → m³)', () => {
    const rows = parseItems(SAMPLE_ITEMS);
    expect(rows).toHaveLength(3);

    const kabagawa = rows[0];
    expect(kabagawa?.stationName).toBe('椛川ダム');
    expect(kabagawa?.observedAt?.toISOString()).toBe('2026-06-05T01:00:00.000Z');
    expect(kabagawa?.waterLevelM).toBeCloseTo(234.56);
    // 1234 千m³ × 1000 = 1,234,000 m³
    expect(kabagawa?.storageVolumeM3).toBeCloseTo(1_234_000);
    expect(kabagawa?.inflowM3s).toBeCloseTo(12.3);
    expect(kabagawa?.outflowM3s).toBeCloseTo(8.5);
  });

  test('handles null stored', () => {
    const rows = parseItems(SAMPLE_ITEMS);
    const yamato = rows[1];
    expect(yamato?.stationName).toBe('大和ダム');
    expect(yamato?.storageVolumeM3).toBeNull();
    expect(yamato?.waterLevelM).toBeCloseTo(156.78);
  });

  test('handles null store and flow values', () => {
    const rows = parseItems(SAMPLE_ITEMS);
    const kawabe = rows[2];
    expect(kawabe?.stationName).toBe('川辺ダム');
    expect(kawabe?.waterLevelM).toBeNull();
    expect(kawabe?.storageVolumeM3).toBeCloseTo(567_000);
    expect(kawabe?.inflowM3s).toBeNull();
    expect(kawabe?.outflowM3s).toBeNull();
  });

  test('returns empty array for empty items', () => {
    expect(parseItems([])).toHaveLength(0);
  });
});
