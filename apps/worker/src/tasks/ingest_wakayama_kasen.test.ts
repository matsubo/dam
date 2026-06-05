import { describe, expect, test } from 'bun:test';
import { parseWakayamaCsv, parseWakayamaTimestamp } from './ingest_wakayama_kasen.ts';

describe('parseWakayamaTimestamp', () => {
  test('parses "YYYYMMDDHHmm" (JST) → UTC', () => {
    const d = parseWakayamaTimestamp('202606052100');
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseWakayamaTimestamp('202606050000');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for wrong length', () => {
    expect(parseWakayamaTimestamp('')).toBeNull();
    expect(parseWakayamaTimestamp('20260605210')).toBeNull();
    expect(parseWakayamaTimestamp('2026060521000')).toBeNull();
  });

  test('returns null for non-numeric input', () => {
    expect(parseWakayamaTimestamp('xxxxxxxxxxxx')).toBeNull();
  });
});

const SAMPLE_CSV = `450,0,0.7,0.7,137.59,743,202606052100
470,0,14.3,16.8,186.68,6054,202606052100
601,0,42.8,45.1,116.64,****,202606052100
22077001,0,7.1,14.0,433.07,****,202606052100
9999,0,1.0,1.0,100.00,100,202606052100
`;

describe('parseWakayamaCsv', () => {
  test('returns known dams only (unknown station code excluded)', () => {
    const rows = parseWakayamaCsv(SAMPLE_CSV);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.wakayamaName)).toEqual([
      '広川ダム',
      '二川ダム',
      '殿山ダム',
      '猿谷ダム',
    ]);
  });

  test('observedAt converted from JST to UTC', () => {
    const rows = parseWakayamaCsv(SAMPLE_CSV);
    for (const r of rows) {
      expect(r.observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    }
  });

  test('広川ダム: all numeric fields parsed correctly', () => {
    const r = parseWakayamaCsv(SAMPLE_CSV).find((x) => x.wakayamaName === '広川ダム');
    expect(r).toBeDefined();
    expect(r?.outflowM3s).toBeCloseTo(0.7);
    expect(r?.inflowM3s).toBeCloseTo(0.7);
    expect(r?.waterLevelM).toBeCloseTo(137.59);
    expect(r?.storageVolumeM3).toBeCloseTo(743_000);
  });

  test('storageVolumeM3 is multiplied by 1000 (千m³ → m³)', () => {
    const r = parseWakayamaCsv(SAMPLE_CSV).find((x) => x.wakayamaName === '二川ダム');
    expect(r?.storageVolumeM3).toBeCloseTo(6_054_000);
  });

  test('"****" storage volume → null', () => {
    const r = parseWakayamaCsv(SAMPLE_CSV).find((x) => x.wakayamaName === '殿山ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.outflowM3s).toBeCloseTo(42.8);
    expect(r?.inflowM3s).toBeCloseTo(45.1);
  });

  test('猿谷ダム: "****" storage and inflow parsing', () => {
    const r = parseWakayamaCsv(SAMPLE_CSV).find((x) => x.wakayamaName === '猿谷ダム');
    expect(r).toBeDefined();
    expect(r?.storageVolumeM3).toBeNull();
    expect(r?.outflowM3s).toBeCloseTo(7.1);
    expect(r?.inflowM3s).toBeCloseTo(14.0);
  });

  test('returns empty array for empty CSV', () => {
    expect(parseWakayamaCsv('')).toHaveLength(0);
    expect(parseWakayamaCsv('\n\n')).toHaveLength(0);
  });

  test('rows with all-null measurements are skipped', () => {
    const csv = '550,0,****,****,****,****,202606052100\n';
    expect(parseWakayamaCsv(csv)).toHaveLength(0);
  });
});
