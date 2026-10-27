// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { okinawaEbEntries, parseOkinawaDate } from './ingest_okinawa_eb.ts';

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

function observed(entries: Entry[], key: string): Observed {
  const r = entries.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('okinawaEbEntries', () => {
  test('lists 倉敷ダム and 山城ダム, not the 国管理 aggregate', () => {
    const entries = okinawaEbEntries(SAMPLE_CSV, NOW_2026);
    expect(entries.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['倉敷ダム', '倉敷ダム', '47'],
      ['山城ダム', '山城ダム', '47'],
    ]);
  });

  test('倉敷ダム: storage volume = 2947000 m³, rate = 0.499 (fraction)', () => {
    const kurasiki = observed(okinawaEbEntries(SAMPLE_CSV, NOW_2026), '倉敷ダム');
    // 2947 千m³ × 1000 = 2,947,000 m³
    expect(kurasiki.storageVolumeM3).toBeCloseTo(2_947_000);
    // The CSV publishes 49.9 (percent); observations.storage_rate is a 0–1
    // fraction, so the adapter must divide by 100. See issue #38 §2-1.
    expect(kurasiki.storageRate).toBeCloseTo(0.499, 5);
  });

  test('山城ダム: storage volume = 859000 m³, rate = 0.722 (fraction)', () => {
    const yamashiro = observed(okinawaEbEntries(SAMPLE_CSV, NOW_2026), '山城ダム');
    expect(yamashiro.storageVolumeM3).toBeCloseTo(859_000);
    expect(yamashiro.storageRate).toBeCloseTo(0.722, 5);
  });

  test('timestamp is midnight JST of stated date', () => {
    // "06月05日" midnight JST = 2026-06-04T15:00:00Z
    expect(
      observed(okinawaEbEntries(SAMPLE_CSV, NOW_2026), '倉敷ダム').observedAt.toISOString(),
    ).toBe('2026-06-04T15:00:00.000Z');
  });

  test('both dams are unreadable when the CSV has too few rows', () => {
    const entries = okinawaEbEntries('06月05日,1,2,3,4\n06月05日,1,2,3,4', NOW_2026);
    expect(entries).toHaveLength(2);
    for (const e of entries) expect(e.reading).toEqual({ state: 'unreadable', why: '2 CSV rows' });
  });

  test('both dams are unreadable when the date cannot be parsed', () => {
    const bad = `invalid date,71674,2947,859,75480
bad,105260,5900,1190,112350
bad,68.1,49.9,72.2,67.2
bad,84.9,74.4,86.3,84.4
bad,-16.8,-24.5,-14.1,-17.2
`;
    for (const e of okinawaEbEntries(bad, NOW_2026)) {
      expect(typeof e.reading !== 'function' && e.reading.state).toBe('unreadable');
    }
  });

  test('a blank column is unreadable, the other dam still read', () => {
    const csv = SAMPLE_CSV.replace('71674,2947,859', '71674,,859').replace(
      '68.1,49.9,72.2',
      '68.1,,72.2',
    );
    const entries = okinawaEbEntries(csv, NOW_2026);
    expect(entries.find((e) => e.key === '倉敷ダム')?.reading).toEqual({
      state: 'unreadable',
      why: 'no number in the column',
    });
    expect(observed(entries, '山城ダム').storageVolumeM3).toBeCloseTo(859_000);
  });

  test('handles trailing newlines and whitespace gracefully', () => {
    const entries = okinawaEbEntries(`${SAMPLE_CSV}\n\n`, NOW_2026);
    expect(observed(entries, '倉敷ダム').storageVolumeM3).toBeCloseTo(2_947_000);
    expect(observed(entries, '山城ダム').storageVolumeM3).toBeCloseTo(859_000);
  });
});
