// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Observed, Reading } from '../ingest/types.ts';
import { dayFileDates, parseShimaneTimestamp, shimaneEntries } from './ingest_shimane_bousai';

const FIXTURE_DIR = path.join(import.meta.dir, '../../../../tests/fixtures/shimane_bousai');

function loadDam60(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'dam60_20260606.json'), 'utf8'));
}

/** Every observation of one station across the day files given. */
function observations(files: Record<string, unknown>[], key: string): readonly Observed[] {
  const r = shimaneEntries(files).find((e) => e.key === key)?.reading as Reading | undefined;
  return r?.state === 'values' ? r.observations : [];
}

function byName(name: string): Observed | undefined {
  const e = shimaneEntries([loadDam60()]).find((x) => x.name === name);
  const r = e?.reading as Reading | undefined;
  return r?.state === 'values' ? r.observations[0] : undefined;
}

describe('parseShimaneTimestamp', () => {
  it('converts JST YYYY-MM-DD-HH-MM to UTC', () => {
    // 2026-06-06 00:00 JST = 2026-06-05 15:00 UTC
    const d = parseShimaneTimestamp('2026-06-06-00-00');
    expect(d?.toISOString()).toBe('2026-06-05T15:00:00.000Z');
  });

  it('handles midnight rollover', () => {
    // 2026-01-01 00:00 JST = 2025-12-31 15:00 UTC
    const d = parseShimaneTimestamp('2026-01-01-00-00');
    expect(d?.toISOString()).toBe('2025-12-31T15:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseShimaneTimestamp('bad')).toBeNull();
    expect(parseShimaneTimestamp('')).toBeNull();
    expect(parseShimaneTimestamp('2026-06-05 08:00:00')).toBeNull();
  });
});

describe('dayFileDates', () => {
  it('reads the previous JST day as well, across the JST (not UTC) date line', () => {
    // 00:37 JST on 9/27 is still 9/26 in UTC; yesterday's file is 9/26.
    expect(dayFileDates(new Date('2026-09-26T15:37:00Z'))).toEqual(['20260926', '20260927']);
    // 08:37 JST on 9/27 is 23:37 UTC on 9/26.
    expect(dayFileDates(new Date('2026-09-26T23:37:00Z'))).toEqual(['20260926', '20260927']);
    expect(dayFileDates(new Date('2026-12-31T15:00:00Z'))).toEqual(['20261231', '20270101']);
  });
});

describe('shimaneEntries', () => {
  it('lists all 19 stations, each with values in the fixture', () => {
    const list = shimaneEntries([loadDam60()]);
    expect(list.length).toBe(19);
    expect(list.every((e) => (e.reading as Reading).state === 'values')).toBe(true);
    expect(list.every((e) => e.pref === '32')).toBe(true);
  });

  it('lists every station as unreadable when no day file was read', () => {
    const list = shimaneEntries([], 'HTTP 503 for 20260606');
    expect(list.length).toBe(19);
    expect(list.map((e) => e.reading)).toContainEqual({
      state: 'unreadable',
      why: 'HTTP 503 for 20260606',
    });
    expect(list.every((e) => (e.reading as Reading).state === 'unreadable')).toBe(true);
  });

  it('a station 未収集 on every item, every hour, is provider-marked empty', () => {
    const marked = { dt: '未収集', st: -1 };
    const file = {
      '2026-06-06-00-00': {
        '8193_7_1': {
          '7_10': marked,
          '7_20': marked,
          '7_41': marked,
          '7_42': marked,
          '7_50': marked,
          '7_70': marked,
        },
      },
    };
    const fube = shimaneEntries([file]).find((e) => e.key === '8193_7_1');
    expect((fube?.reading as Reading | undefined)?.state).toBe('empty');
  });

  it('reads every hourly key in the file, not only the latest', () => {
    // The file seen at hh:37 JST lags ~2 h, so reading only its newest key
    // never stored 22:00 or 23:00 (26 of 26 days in September). Yesterday's
    // complete file carries them; this fixture is its last three keys.
    const file = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, 'dam60_20260926_last3h.json'), 'utf8'),
    );
    const all = shimaneEntries([file]).flatMap((e) => {
      const r = e.reading as Reading;
      return r.state === 'values' ? r.observations : [];
    });
    expect(all.length).toBe(3 * 19);
    const hachinohe = observations([file], '8193_7_4');
    expect(
      hachinohe.map((o) => [o.observedAt.toISOString(), o.waterLevelM, o.storageVolumeM3]),
    ).toEqual([
      ['2026-09-26T12:00:00.000Z', 105.07, 4_107_000],
      ['2026-09-26T13:00:00.000Z', 105.09, 4_117_000],
      ['2026-09-26T14:00:00.000Z', 105.11, 4_128_000],
    ]);
    // 9/26 is 洪水期, so each key reads 7_41 (79.2 %), not 7_42 (20.3 %).
    const at22 = hachinohe.find((o) => o.observedAt.toISOString() === '2026-09-26T13:00:00.000Z');
    expect(at22?.storageRate).toBeCloseTo(0.792, 5);
  });

  it('converts storageVolumeM3 from 千m³ to m³', () => {
    // fixture: 八戸ダム 7_20 = 5900 千m³ → 5,900,000 m³
    expect(byName('八戸ダム')?.storageVolumeM3).toBe(5_900_000);
  });

  it('converts storageRate % → 0-1 fraction', () => {
    // 布部ダム on 2026-06-06 (非洪水期): 7_42=58.8%
    expect(byName('布部ダム')?.storageRate).toBeCloseTo(0.588, 5);
  });

  it('returns null storageRate when item is 未収集 (st == -1)', () => {
    // 浜田ダム: 7_41 and 7_42 both st=-1 (未収集)
    expect(byName('浜田ダム')?.storageRate).toBeNull();
  });

  it('parses water level and inflow correctly', () => {
    const hachito = byName('八戸ダム');
    expect(hachito?.waterLevelM).toBeCloseTo(108.34, 2);
    expect(hachito?.inflowM3s).toBeCloseTo(2.57, 2);
    expect(hachito?.outflowM3s).toBeCloseTo(9.71, 2);
  });

  it('uses 7_42 (非洪水期) outside the flood season — fixture is 6/6', () => {
    // 7_41 reads a capped 100.0 for both: they still held more than their
    // 洪水期 pool on 6/6 (布部 2,509 vs ~2,300 千m³; 八戸 5,900 vs ~5,200).
    expect(byName('布部ダム')?.storageRate).toBeCloseTo(0.588, 5);
    expect(byName('八戸ダム')?.storageRate).toBeCloseTo(0.291, 5);
  });

  // 布部 / 八戸 are the only stations whose 7_41 and 7_42 differ.
  const seasonal = (ts: string) => ({
    [ts]: {
      '8193_7_1': {
        '7_41': { dt: '59.4', st: 0 },
        '7_42': { dt: '32.0', st: 0 },
      },
    },
  });

  it.each([
    ['2026-06-15-23-00', 0.32],
    ['2026-06-16-00-00', 0.594],
    ['2026-09-25-05-00', 0.594],
    ['2026-09-30-23-00', 0.594],
    ['2026-10-01-00-00', 0.32],
    ['2026-01-10-12-00', 0.32],
  ])('picks the rate for the season of %s (JST)', (ts, expected) => {
    expect(observations([seasonal(ts)], '8193_7_1')[0]?.storageRate).toBeCloseTo(expected, 5);
  });

  it('does not fall back to the other season when the current one is 未収集', () => {
    const snapshot = {
      '2026-10-01-00-00': {
        '8193_7_1': {
          '7_41': { dt: '59.4', st: 0 },
          '7_42': { dt: '未収集', st: -1 },
          '7_10': { dt: '190.00', st: 0 },
        },
      },
    };
    expect(observations([snapshot], '8193_7_1')[0]?.storageRate).toBeNull();
  });

  it('timestamp matches fixture key', () => {
    // 2026-06-06-00-00 JST = 2026-06-05T15:00:00.000Z
    expect(byName('布部ダム')?.observedAt.toISOString()).toBe('2026-06-05T15:00:00.000Z');
  });

  it('lists every station as unreadable for malformed data', () => {
    for (const file of [{}, { update: '2026-06-06-00-05' }]) {
      const list = shimaneEntries([file]);
      expect(list.length).toBe(19);
      expect(list.every((e) => (e.reading as Reading).state === 'unreadable')).toBe(true);
    }
  });

  it('clamps storageRate to [0, 1]', () => {
    const snapshot = {
      '2026-06-06-00-00': {
        '8193_7_1': {
          '7_42': { dt: '105.0', st: 0 }, // 105% > 1 → should clamp to 1
          '7_10': { dt: '190.00', st: 0 },
        },
      },
    };
    expect(observations([snapshot], '8193_7_1')[0]?.storageRate).toBe(1.0);
  });
});
