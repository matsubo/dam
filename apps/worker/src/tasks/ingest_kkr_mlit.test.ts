// apps/worker/src/tasks/ingest_kkr_mlit.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Reading } from '../ingest/types.ts';
import { kkrEntries, parseKkrDatetime, toFraction } from './ingest_kkr_mlit.ts';

function readingOf(e: Entry | undefined): Reading {
  if (!e || typeof e.reading === 'function') throw new Error('expected a static reading');
  return e.reading;
}

describe('parseKkrDatetime', () => {
  test('parses "YYYY-MM-DD HH:MM:SS" JST → UTC (subtract 9h)', () => {
    const d = parseKkrDatetime('2026-06-05 15:00:00');
    expect(d).not.toBeNull();
    // 15:00 JST = 06:00 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:00:00.000Z');
  });

  test('handles midnight crossover (JST 06:00 → previous UTC day 21:00)', () => {
    const d = parseKkrDatetime('2026-06-05 06:00:00');
    expect(d).not.toBeNull();
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseKkrDatetime('bad')).toBeNull();
    expect(parseKkrDatetime('')).toBeNull();
    expect(parseKkrDatetime('2026-06-05')).toBeNull();
    expect(parseKkrDatetime('2026/06/05 15:00:00')).toBeNull();
  });
});

describe('kkrEntries', () => {
  const BASE_JSON = {
    datetime: '2026-06-05 15:00:00',
    lake: { biwako: { suii: { today: '7', diff: ['-4', '&darr;'] } } },
    dam: {
      managawa: { chosuiritsu: { today: '56.4', diff: ['-1.1', '&darr;'] } },
      kuzuryu: { chosuiritsu: { today: '64.1', diff: ['-0.4', '&darr;'] } },
      amagase: { chosuiritsu: { today: '71.9', diff: ['1', '&uarr;'] } },
      muro: { chosuiritsu: { today: '74.9', diff: ['2.4', '&uarr;'] } },
      syourenji: { chosuiritsu: { today: '81.2', diff: ['-2.3', '&darr;'] } },
      takayama: { chosuiritsu: { today: '30.2', diff: ['-4', '&darr;'] } },
      nunome: { chosuiritsu: { today: '81.5', diff: ['0.8', '&uarr;'] } },
      hiyoshi: { chosuiritsu: { today: '53.9', diff: ['-2.1', '&darr;'] } },
      hinati: { chosuiritsu: { today: '69.9', diff: ['-2.2', '&darr;'] } },
      hitokura: { chosuiritsu: { today: '60.6', diff: ['-2.1', '&darr;'] } },
      otaki: { chosuiritsu: { today: '47.4', diff: ['-0.5', '&darr;'] } },
      sarutani: { chosuiritsu: { today: '82.9', diff: ['-0.3', '&darr;'] } },
    },
  };
  const entry = (json: unknown, key: string) => kkrEntries(json).find((e) => e.key === key);

  test('lists all 12 dams from typical JSON, keyed by the JSON key', () => {
    const entries = kkrEntries(BASE_JSON);
    expect(entries).toHaveLength(12);
    expect(entry(BASE_JSON, 'amagase')?.name).toBe('天ヶ瀬ダム');
    expect(entry(BASE_JSON, 'hinati')?.name).toBe('比奈知ダム');
    expect(entries.every((e) => readingOf(e).state === 'values')).toBe(true);
  });

  test('scopes each dam to the prefecture of its master (高山 is 京都, not 奈良)', () => {
    expect(entry(BASE_JSON, 'takayama')?.pref).toBe('26');
    expect(entry(BASE_JSON, 'hitokura')?.pref).toBe('28');
  });

  test('converts datetime to UTC and reads 貯水率 as a 0..1 fraction, not the published percent', () => {
    // This test used to assert 56.4 — the published percent — and so encoded
    // the #46 bug rather than catching it: observations.storage_rate is a
    // fraction, so every stored rate was 100x too large.
    const managawa = readingOf(entry(BASE_JSON, 'managawa'));
    if (managawa.state !== 'values') throw new Error(managawa.state);
    // 15:00 JST = 06:00 UTC
    expect(managawa.observations[0]?.observedAt.toISOString()).toBe('2026-06-05T06:00:00.000Z');
    expect(managawa.observations[0]?.storageRate).toBeCloseTo(0.564, 4);
    const takayama = readingOf(entry(BASE_JSON, 'takayama'));
    if (takayama.state !== 'values') throw new Error(takayama.state);
    expect(takayama.observations[0]?.storageRate).toBeCloseTo(0.302, 4);
  });

  test('an invalid datetime leaves every dam unreadable', () => {
    const entries = kkrEntries({ ...BASE_JSON, datetime: 'invalid' });
    expect(entries).toHaveLength(12);
    expect(entries.every((e) => readingOf(e).state === 'unreadable')).toBe(true);
  });

  test('a configured dam missing from the JSON is still listed, unreadable', () => {
    const partial = {
      ...BASE_JSON,
      dam: {
        managawa: { chosuiritsu: { today: '56.4', diff: ['-1.1', '&darr;'] } },
        kuzuryu: { chosuiritsu: { today: '64.1', diff: ['-0.4', '&darr;'] } },
      },
    };
    const entries = kkrEntries(partial);
    expect(entries).toHaveLength(12);
    expect(entries.slice(0, 2).map((e) => e.key)).toEqual(['managawa', 'kuzuryu']);
    expect(readingOf(entry(partial, 'amagase'))).toEqual({
      state: 'unreadable',
      why: "not in today's feed",
    });
  });

  test('a key the feed adds is listed under the five prefectures', () => {
    const added = entry({ ...BASE_JSON, dam: { ...BASE_JSON.dam, newdam: {} } }, 'newdam');
    expect(added?.name).toBe('newdam');
    expect(added?.pref).toEqual(['18', '26', '29', '24', '28']);
  });

  test('an empty or missing 貯水率 is unreadable', () => {
    const json = {
      ...BASE_JSON,
      dam: {
        ...BASE_JSON.dam,
        managawa: { chosuiritsu: { today: '', diff: ['', ''] } },
        amagase: {},
      },
    };
    expect(readingOf(entry(json, 'managawa')).state).toBe('unreadable');
    expect(readingOf(entry(json, 'amagase')).state).toBe('unreadable');
  });
});

describe('toFraction (#46)', () => {
  test('converts a published percent to a 0..1 fraction', () => {
    // The feed publishes "89.3"; storage_rate is a fraction. Writing the
    // percent straight through meant 8,930 % — the okinawa bug (#38 §2-1).
    expect(toFraction(89.3)).toBeCloseTo(0.893, 6);
    expect(toFraction(36.7)).toBeCloseTo(0.367, 6);
  });

  test('accepts a full reservoir, which used to overflow the column', () => {
    // storage_rate is NUMERIC(6,4) — max 99.9999. 一庫ダム published exactly
    // 100.0 on 2026-09-14 and the raw percent overflowed, failing the whole
    // task and leaving every 近畿 dam stale.
    expect(toFraction(100)).toBeCloseTo(1, 6);
    expect(toFraction(104.5)).toBeCloseTo(1.045, 6);
  });

  test('rejects a reading that cannot be a rate rather than clipping it', () => {
    // Clipped values are indistinguishable from real ones downstream, and a
    // stored 0 would recreate the phantom zeros 0038/0039 had to undo.
    expect(toFraction(0)).toBeNull();
    expect(toFraction(-1)).toBeNull();
    expect(toFraction(250)).toBeNull();
    expect(toFraction(Number.NaN)).toBeNull();
    expect(toFraction(null)).toBeNull();
  });
});
