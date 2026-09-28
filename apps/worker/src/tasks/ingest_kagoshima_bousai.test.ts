// apps/worker/src/tasks/ingest_kagoshima_bousai.test.ts
//
// The Kagoshima portal lists dams only during a flood (items=[] on
// 2026-09-28), so the vendor-format fixture is the same vendor's live Kagawa
// feed: a verbatim capture of bousai-kagawa.jp/bousai_data/tm/dam_station.json
// taken 2026-09-28 12:54 JST (ret_time). It carries the real item shape —
// `point` as a WKT string ("POINT(134.21909 34.24903)", "POINT(0 0)" for
// 野口) and 粟井ダム published with every value null.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BousaiItem, BousaiResponse } from './ingest_kagoshima_bousai.ts';
import {
  chooseMaster,
  parseItems,
  parseKagoshimaTimestamp,
  toObservations,
} from './ingest_kagoshima_bousai.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kagoshima_bousai/kagawa_dam_station_2026-09-28T1254.json',
);

const vendor = parseItems((JSON.parse(await readFile(FIXTURE, 'utf8')) as BousaiResponse).items);

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
    point: 'POINT(130.5 31.5)',
    obs_datetime: '2026/06/05 10:00',
    store: 234.56,
    stored: 1234,
    inflow: 12.3,
    discharge: 8.5,
  },
  {
    station_name: '大和ダム',
    station_no: '013707002000000000',
    point: 'POINT(130.6 31.6)',
    obs_datetime: '2026/06/05 10:00',
    store: 156.78,
    stored: null,
    inflow: 5.6,
    discharge: 3.2,
  },
  {
    station_name: '川辺ダム',
    station_no: '013707010000000000',
    point: 'POINT(130.3 31.3)',
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

  test('reads the vendor WKT point "POINT(lon lat)" as lat/lng', () => {
    const monnyu = vendor.find((r) => r.stationName === '門入ダム');
    expect(monnyu?.lat).toBe(34.24903);
    expect(monnyu?.lng).toBe(134.21909);
  });

  test('POINT(0 0) is no position, not the Gulf of Guinea', () => {
    const noguchi = vendor.find((r) => r.stationName === '野口ダム');
    expect(noguchi?.lat).toBeNull();
    expect(noguchi?.lng).toBeNull();
    expect(noguchi?.waterLevelM).toBe(249.17);
  });
});

describe('toObservations', () => {
  const matched = new Map([
    ['門入ダム', 1n],
    ['粟井ダム', 2n],
  ]);

  test('skips a matched station published with every value null (粟井)', () => {
    const logs: string[] = [];
    const inputs = toObservations(vendor, matched, (s) => logs.push(s));
    expect(inputs.map((i) => i.damId)).toEqual([1n]);
    expect(inputs[0]?.observedAt.toISOString()).toBe('2026-09-28T03:40:00.000Z');
    expect(inputs[0]?.storageVolumeM3).toBe(1_731_000);
    expect(logs.some((s) => s.includes('粟井ダム'))).toBe(true);
  });

  test('keeps a row that carries only flows', () => {
    const rows = parseItems([
      {
        station_name: '川辺ダム',
        station_no: '013707010000000000',
        obs_datetime: '2026/06/05 10:00',
        store: null,
        stored: null,
        inflow: 3.1,
        discharge: null,
      },
    ]);
    const inputs = toObservations(rows, new Map([['川辺ダム', 3n]]), () => {});
    expect(inputs.map((i) => i.inflowM3s)).toEqual([3.1]);
  });
});

describe('chooseMaster (#79)', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp });

  test('keeps the row already stamped with the station number over a lower-id name hit', () => {
    const masters = [m(10, '大和'), m(20, '大和', null, '013707002000000000')];
    expect(chooseMaster('大和ダム', '大和', masters, '013707002000000000')).toBe(20n);
  });

  test('binds 鶴田 to the completed （再）, not the lower-id （元）', () => {
    // Real pref-46 twin rows and completion years from the master.
    const masters = [m(11438, '鶴田（元）', 2017), m(11453, '鶴田（再）', 2017)];
    expect(chooseMaster('鶴田ダム', '鶴田', masters, '013707099000000000')).toBe(11453n);
  });
});
