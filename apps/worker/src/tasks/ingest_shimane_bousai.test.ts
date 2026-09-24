import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  normalizeName,
  type ParsedRow,
  parseShimaneSnapshot,
  parseShimaneTimestamp,
} from './ingest_shimane_bousai';

const FIXTURE_DIR = path.join(import.meta.dir, '../../../../tests/fixtures/shimane_bousai');

function loadDam60(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'dam60_20260606.json'), 'utf8'));
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

describe('normalizeName', () => {
  it('strips ダム suffix', () => {
    expect(normalizeName('布部ダム')).toBe('布部');
    expect(normalizeName('第二浜田ダム')).toBe('第二浜田');
    expect(normalizeName('益田川ダム')).toBe('益田川');
  });

  it('strips annotations', () => {
    expect(normalizeName('銚子（隠岐）ダム')).toBe('銚子');
  });

  it('is a no-op on bare names', () => {
    expect(normalizeName('布部')).toBe('布部');
  });
});

describe('parseShimaneSnapshot', () => {
  it('parses 19 dam rows from fixture', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    expect(rows.length).toBe(19);
  });

  it('converts storageVolumeM3 from 千m³ to m³', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    const hachitoRow = rows.find((r: ParsedRow) => r.shimaneName === '八戸ダム');
    expect(hachitoRow).toBeDefined();
    // fixture: 八戸ダム 7_20 = 5900 千m³ → 5,900,000 m³
    expect(hachitoRow?.storageVolumeM3).toBe(5_900_000);
  });

  it('converts storageRate % → 0-1 fraction', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    const fubeRow = rows.find((r: ParsedRow) => r.shimaneName === '布部ダム');
    // 布部ダム on 2026-06-06 (非洪水期): 7_42=58.8%
    expect(fubeRow?.storageRate).toBeCloseTo(0.588, 5);
  });

  it('returns null storageRate when item is 未収集 (st == -1)', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    const hamadaRow = rows.find((r: ParsedRow) => r.shimaneName === '浜田ダム');
    // 浜田ダム: 7_41 and 7_42 both st=-1 (未収集)
    expect(hamadaRow?.storageRate).toBeNull();
  });

  it('parses water level and inflow correctly', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    const hachitoRow = rows.find((r: ParsedRow) => r.shimaneName === '八戸ダム');
    expect(hachitoRow?.waterLevelM).toBeCloseTo(108.34, 2);
    expect(hachitoRow?.inflowM3s).toBeCloseTo(2.57, 2);
    expect(hachitoRow?.outflowM3s).toBeCloseTo(9.71, 2);
  });

  it('uses 7_42 (非洪水期) outside the flood season — fixture is 6/6', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    const byName = (n: string) => rows.find((r: ParsedRow) => r.shimaneName === n);
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
  const fubeRate = (ts: string) =>
    parseShimaneSnapshot(seasonal(ts)).find((r: ParsedRow) => r.stationId === '8193_7_1')
      ?.storageRate;

  it.each([
    ['2026-06-15-23-00', 0.32],
    ['2026-06-16-00-00', 0.594],
    ['2026-09-25-05-00', 0.594],
    ['2026-09-30-23-00', 0.594],
    ['2026-10-01-00-00', 0.32],
    ['2026-01-10-12-00', 0.32],
  ])('picks the rate for the season of %s (JST)', (ts, expected) => {
    expect(fubeRate(ts)).toBeCloseTo(expected, 5);
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
    const row = parseShimaneSnapshot(snapshot).find((r: ParsedRow) => r.stationId === '8193_7_1');
    expect(row?.storageRate).toBeNull();
  });

  it('timestamp matches fixture key', () => {
    const rows = parseShimaneSnapshot(loadDam60());
    // 2026-06-06-00-00 JST = 2026-06-05T15:00:00.000Z
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T15:00:00.000Z');
  });

  it('returns empty array for malformed data', () => {
    expect(parseShimaneSnapshot({})).toHaveLength(0);
    expect(parseShimaneSnapshot({ update: '2026-06-06-00-05' })).toHaveLength(0);
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
    const rows = parseShimaneSnapshot(snapshot);
    const row = rows.find((r: ParsedRow) => r.stationId === '8193_7_1');
    expect(row?.storageRate).toBe(1.0);
  });
});
