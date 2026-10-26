// apps/worker/src/tasks/ingest_kagawa_bousai.test.ts
//
// Feed → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { kagawaEntries, parseKagawaTimestamp } from './ingest_kagawa_bousai.ts';

function observed(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}
const state = (e: Entry | undefined) =>
  e && typeof e.reading !== 'function' ? e.reading.state : undefined;

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

describe('kagawaEntries', () => {
  const entries = kagawaEntries(SAMPLE_JSON);
  const named = (n: string) => entries.find((e) => e.name === n);

  test('returns 3 entries keyed by the published name', () => {
    expect(entries.map((e) => [e.key, e.pref])).toEqual([
      ['内場ダム', '37'],
      ['野口ダム', '37'],
      ['内海ダム', '37'],
    ]);
  });

  test('observedAt converted from JST to UTC', () => {
    for (const e of entries) {
      expect(observed(e)?.observedAt.toISOString()).toBe('2026-06-05T12:00:00.000Z');
    }
  });

  test('内場ダム: all fields parsed correctly', () => {
    const r = observed(named('内場ダム'));
    expect(r?.storageRate).toBeCloseTo(0.965);
    expect(r?.storageVolumeM3).toBeCloseTo(7_147_000);
    expect(r?.waterLevelM).toBeCloseTo(257.95);
    expect(r?.inflowM3s).toBeCloseTo(1.33);
    expect(r?.outflowM3s).toBeCloseTo(2.08);
  });

  test('野口ダム: null discharge and storage_rate → null', () => {
    const r = observed(named('野口ダム'));
    expect(r?.outflowM3s).toBeNull();
    expect(r?.storageRate).toBeNull();
    expect(r?.storageVolumeM3).toBeCloseTo(932_000);
  });

  test('内海ダム: storage_rate > 100% clamped to 1.0', () => {
    expect(observed(named('内海ダム'))?.storageRate).toBe(1);
  });

  test('a dam whose every value is null is provider-marked empty (粟井, 2026-10-27)', () => {
    const awai = {
      station_name: '粟井ダム',
      obs_datetime: '2026/10/27 00:40',
      store: null,
      stored: null,
      storage_rate: null,
      inflow: null,
      discharge: null,
    };
    expect(state(kagawaEntries({ items: [awai] })[0])).toBe('empty');
  });

  test('a value without a readable obs_datetime, or with no value fields at all, is unreadable', () => {
    const base = SAMPLE_JSON.items[0];
    if (!base) throw new Error('fixture missing');
    const undated = { ...base, obs_datetime: '' };
    const bare = { station_name: '内場ダム', obs_datetime: '2026/06/05 21:00' };
    expect(kagawaEntries({ items: [undated, bare] }).map(state)).toEqual([
      'unreadable',
      'unreadable',
    ]);
  });

  test('lists nothing for empty items', () => {
    expect(kagawaEntries({ items: [] })).toHaveLength(0);
    expect(kagawaEntries({})).toHaveLength(0);
  });
});
