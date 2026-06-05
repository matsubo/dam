import { describe, expect, test } from 'bun:test';
import { parseOkinawaDate, parseOkinawaEbCsv } from './ingest_okinawa_eb.ts';

// Fixed "now" anchored in 2026 for deterministic tests
const NOW_2026 = new Date('2026-06-05T06:00:00.000Z'); // 2026-06-05 15:00 JST

describe('parseOkinawaDate', () => {
  test('parses MM月DD日 → midnight JST → UTC', () => {
    // "06月05日" at midnight JST = 2026-06-04T15:00:00Z
    const d = parseOkinawaDate('06月05日', NOW_2026);
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns same-year date when not in future', () => {
    const d = parseOkinawaDate('01月01日', NOW_2026);
    // Jan 1 2026 midnight JST = 2025-12-31T15:00:00Z
    expect(d?.getUTCFullYear()).toBe(2025);
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  test('falls back to previous year when date is >1 day ahead', () => {
    // "12月31日" in the context of 2026-06-05 → would be Dec 31 2026, which is
    // far in the future → should be Dec 31 2025 instead
    const d = parseOkinawaDate('12月31日', NOW_2026);
    expect(d?.getUTCFullYear()).toBe(2025);
    expect(d?.toISOString()).toBe('2025-12-30T15:00:00.000Z');
  });

  test('accepts tomorrow (within 1-day tolerance)', () => {
    // "06月06日" is 1 day ahead of NOW_2026 — within tolerance, use current year
    const d = parseOkinawaDate('06月06日', NOW_2026);
    expect(d?.getUTCFullYear()).toBe(2026);
    expect(d?.toISOString()).toBe('2026-06-05T15:00:00.000Z');
  });

  test('returns null for non-matching string', () => {
    expect(parseOkinawaDate('', NOW_2026)).toBeNull();
    expect(parseOkinawaDate('2026-06-05', NOW_2026)).toBeNull();
    expect(parseOkinawaDate('06月', NOW_2026)).toBeNull();
  });
});

const SAMPLE_CSV = `06月05日,71674,2947,859,75480
06月05日,105260,5900,1190,112350
06月05日,68.1,49.9,72.2,67.2
06月05日,84.9,74.4,86.3,84.4
06月05日,-16.8,-24.5,-14.1,-17.2
`;

describe('parseOkinawaEbCsv', () => {
  test('returns two rows for 倉敷ダム and 山城ダム', () => {
    const rows = parseOkinawaEbCsv(SAMPLE_CSV, NOW_2026);
    expect(rows).toHaveLength(2);
    const kurasiki = rows.find((r) => r.csvName === '倉敷ダム');
    const yamashiro = rows.find((r) => r.csvName === '山城ダム');
    expect(kurasiki).not.toBeNull();
    expect(yamashiro).not.toBeNull();
  });

  test('倉敷ダム: storage volume = 2947000 m³, rate = 49.9%', () => {
    const rows = parseOkinawaEbCsv(SAMPLE_CSV, NOW_2026);
    const kurasiki = rows.find((r) => r.csvName === '倉敷ダム');
    expect(kurasiki).not.toBeUndefined();
    // 2947 千m³ × 1000 = 2,947,000 m³
    expect(kurasiki?.storageVolumeM3).toBeCloseTo(2_947_000);
    expect(kurasiki?.storageRate).toBeCloseTo(49.9);
  });

  test('山城ダム: storage volume = 859000 m³, rate = 72.2%', () => {
    const rows = parseOkinawaEbCsv(SAMPLE_CSV, NOW_2026);
    const yamashiro = rows.find((r) => r.csvName === '山城ダム');
    expect(yamashiro).not.toBeUndefined();
    expect(yamashiro?.storageVolumeM3).toBeCloseTo(859_000);
    expect(yamashiro?.storageRate).toBeCloseTo(72.2);
  });

  test('timestamp is midnight JST of stated date', () => {
    const rows = parseOkinawaEbCsv(SAMPLE_CSV, NOW_2026);
    // "06月05日" midnight JST = 2026-06-04T15:00:00Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns empty array when CSV has too few rows', () => {
    expect(parseOkinawaEbCsv('06月05日,1,2,3,4\n06月05日,1,2,3,4', NOW_2026)).toHaveLength(0);
  });

  test('returns empty array when date cannot be parsed', () => {
    const bad = `invalid date,71674,2947,859,75480
bad,105260,5900,1190,112350
bad,68.1,49.9,72.2,67.2
bad,84.9,74.4,86.3,84.4
bad,-16.8,-24.5,-14.1,-17.2
`;
    expect(parseOkinawaEbCsv(bad, NOW_2026)).toHaveLength(0);
  });

  test('handles trailing newlines and whitespace gracefully', () => {
    const csv = `${SAMPLE_CSV}\n\n`;
    const rows = parseOkinawaEbCsv(csv, NOW_2026);
    expect(rows).toHaveLength(2);
  });
});
