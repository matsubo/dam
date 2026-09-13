// apps/worker/src/tasks/backfill_kagoshima_bodik.test.ts

import { describe, expect, test } from 'bun:test';
import {
  extractYearFromResourceName,
  parseKagoshimaCsv,
  parseKagoshimaTimestamp,
} from './backfill_kagoshima_bodik.ts';

// Minimal CSV fixture matching the real Kagoshima format.
// Row 0: dam name. Row 1: column IDs. Row 2: column names. Row 3: units. Row 4+: data.
function makeCsv(damName: string, rows: string[]): string {
  return [
    `${damName},,,,,,,`,
    '1,1,3,4,2,5,17,18',
    '観測時刻,貯水位,全流入量,全放流量,貯水量,空容量,貯水率（治水）,貯水率（利水）',
    ',[EL.10^2m],[10＾-3m3/s],[10＾-3m3/s],[10＾3m3],[10＾3m3],[10^-1%],[10^-1%]',
    ...rows,
  ].join('\n');
}

describe('parseKagoshimaTimestamp', () => {
  test('parses "YYYY/M/D H:MM" JST → UTC (subtract 9h)', () => {
    const d = parseKagoshimaTimestamp('2026/1/1 0:10');
    expect(d).not.toBeNull();
    // 0:10 JST = previous day 15:10 UTC
    expect(d?.toISOString()).toBe('2025-12-31T15:10:00.000Z');
  });

  test('parses "YYYY/MM/DD HH:MM" with leading zeros', () => {
    const d = parseKagoshimaTimestamp('2026/06/05 14:20');
    expect(d).not.toBeNull();
    // 14:20 JST = 05:20 UTC
    expect(d?.toISOString()).toBe('2026-06-05T05:20:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseKagoshimaTimestamp('2026/6/5 8:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseKagoshimaTimestamp('bad')).toBeNull();
    expect(parseKagoshimaTimestamp('')).toBeNull();
    expect(parseKagoshimaTimestamp('2026/1/1')).toBeNull();
  });
});

describe('parseKagoshimaCsv', () => {
  test('extracts dam name and applies unit conversions', () => {
    const csv = makeCsv('川辺ダム', ['2026/1/1 0:10,14998,619,619,658,,997,']);
    const rows = parseKagoshimaCsv(csv);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r?.damName).toBe('川辺ダム');
    // 貯水位: 14998 / 100 = 149.98 m
    expect(r?.waterLevelM).toBeCloseTo(149.98);
    // 流入量: 619 / 1000 = 0.619 m³/s
    expect(r?.inflowM3s).toBeCloseTo(0.619);
    // 放流量: 619 / 1000 = 0.619 m³/s
    expect(r?.outflowM3s).toBeCloseTo(0.619);
    // 貯水量: 658 * 1000 = 658,000 m³
    expect(r?.storageVolumeM3).toBe(658_000);
    // 貯水率: 997 / 10 = 99.7%
    expect(r?.storageRate).toBeCloseTo(99.7);
  });

  test('water level conversion: raw / 100 = EL.m', () => {
    const csv = makeCsv('大和ダム', ['2026/1/1 0:10,3676,89,39,193,528,268,948']);
    const rows = parseKagoshimaCsv(csv);
    expect(rows[0]?.waterLevelM).toBeCloseTo(36.76);
  });

  test('storage volume conversion: raw * 1000 = m³', () => {
    const csv = makeCsv('大和ダム', ['2026/1/1 0:10,3676,89,39,745,,268,1000']);
    const rows = parseKagoshimaCsv(csv);
    expect(rows[0]?.storageVolumeM3).toBe(745_000);
  });

  test('storage rate: prefers 治水 (col 6) over 利水 (col 7)', () => {
    const csv = makeCsv('大和ダム', ['2026/1/1 0:10,3676,89,39,193,528,268,948']);
    const rows = parseKagoshimaCsv(csv);
    // 治水 268 / 10 = 26.8% (prefer over 利水 94.8%)
    expect(rows[0]?.storageRate).toBeCloseTo(26.8);
  });

  test('falls back to 利水 rate when 治水 is missing', () => {
    const _csv = makeCsv('川辺ダム', ['2026/1/1 0:10,14998,619,619,658,,997,']);
    // cols[6] = '997' (no 治水), cols[7] = '' (no 利水)
    // Actually let me fix: col6='997' means it IS 治水. Let me use col6='' and col7='997'
    const csv2 = makeCsv('川辺ダム', ['2026/1/1 0:10,14998,619,619,658,,,997']);
    const rows = parseKagoshimaCsv(csv2);
    expect(rows[0]?.storageRate).toBeCloseTo(99.7);
  });

  test('handles missing optional fields (empty = null)', () => {
    const csv = makeCsv('西之谷ダム', ['2026/1/1 0:10,4368,1948,1948,5,,7,']);
    const rows = parseKagoshimaCsv(csv);
    expect(rows[0]?.storageVolumeM3).toBe(5_000);
    expect(rows[0]?.storageRate).toBeCloseTo(0.7);
    // 利水 is blank → null
    // But 治水 (col6=7) → 0.7%
  });

  test('parses multiple rows', () => {
    const csv = makeCsv('大和ダム', [
      '2026/1/1 0:10,3676,89,39,193,528,268,948',
      '2026/1/1 0:20,3676,89,39,193,528,268,948',
      '2026/1/1 0:30,3677,90,40,193,528,268,948',
    ]);
    expect(parseKagoshimaCsv(csv)).toHaveLength(3);
  });

  test('skips rows with unparseable timestamps', () => {
    const csv = makeCsv('大和ダム', [
      '2026/1/1 0:10,3676,89,39,193,528,268,948',
      'bad_date,3676,89,39,193,528,268,948',
      '2026/1/1 0:30,3677,90,40,193,528,268,948',
    ]);
    expect(parseKagoshimaCsv(csv)).toHaveLength(2);
  });

  test('returns empty for short input (fewer than 5 lines)', () => {
    expect(parseKagoshimaCsv('')).toHaveLength(0);
    expect(parseKagoshimaCsv('川辺ダム,,\n1,2,3\n')).toHaveLength(0);
  });

  test('JST timestamp correctly converted to UTC', () => {
    const csv = makeCsv('大和ダム', ['2026/3/31 4:30,15055,33223,8074,745,,1000,']);
    const rows = parseKagoshimaCsv(csv);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-03-30T19:30:00.000Z');
    // 4:30 JST - 9h = -4:30 → 2026-03-30T19:30:00Z ✓
  });
});

describe('extractYearFromResourceName', () => {
  test('extracts year from standard resource name', () => {
    expect(extractYearFromResourceName('ダム諸量情報（2024年1月〜12月）')).toBe(2024);
    expect(extractYearFromResourceName('ダム諸量情報（2026年1月〜5月）')).toBe(2026);
    expect(extractYearFromResourceName('ダム諸量情報（2008年1月〜12月）')).toBe(2008);
  });

  test('returns null for unrecognized format', () => {
    expect(extractYearFromResourceName('unknown resource')).toBeNull();
    expect(extractYearFromResourceName('')).toBeNull();
  });
});
