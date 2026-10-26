// apps/worker/src/tasks/ingest_kagoshima_bousai.test.ts
//
// The Kagoshima portal lists dams only during a flood (items=[] on
// 2026-09-28), so the vendor-format fixture is the same vendor's live Kagawa
// feed: a verbatim capture of bousai-kagawa.jp/bousai_data/tm/dam_station.json
// taken 2026-09-28 12:54 JST (ret_time). It carries the real item shape —
// `point` as a WKT string ("POINT(134.21909 34.24903)", "POINT(0 0)" for
// 野口) and 粟井ダム published with every value null.
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import {
  type BousaiItem,
  type BousaiResponse,
  kagoshimaBousaiEntries,
  parseKagoshimaTimestamp,
} from './ingest_kagoshima_bousai.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kagoshima_bousai/kagawa_dam_station_2026-09-28T1254.json',
);

const vendor = kagoshimaBousaiEntries(
  (JSON.parse(await readFile(FIXTURE, 'utf8')) as BousaiResponse).items,
);

function observation(e: Entry | undefined) {
  const r = e?.reading as Reading | undefined;
  if (r?.state !== 'values') throw new Error('no values');
  const o = r.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

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

describe('kagoshimaBousaiEntries', () => {
  test('keys by station_no, reads the timestamp and converts stored (千m³ → m³)', () => {
    const list = kagoshimaBousaiEntries(SAMPLE_ITEMS);
    expect(list).toHaveLength(3);

    expect(list[0]?.key).toBe('013707018000000000');
    expect(list[0]?.name).toBe('椛川ダム');
    expect(list[0]?.pref).toBe('46');
    const kabagawa = observation(list[0]);
    expect(kabagawa.observedAt.toISOString()).toBe('2026-06-05T01:00:00.000Z');
    expect(kabagawa.waterLevelM).toBeCloseTo(234.56);
    // 1234 千m³ × 1000 = 1,234,000 m³
    expect(kabagawa.storageVolumeM3).toBeCloseTo(1_234_000);
    expect(kabagawa.inflowM3s).toBeCloseTo(12.3);
    expect(kabagawa.outflowM3s).toBeCloseTo(8.5);
  });

  test('handles null stored', () => {
    const yamato = observation(kagoshimaBousaiEntries(SAMPLE_ITEMS)[1]);
    expect(yamato.storageVolumeM3).toBeNull();
    expect(yamato.waterLevelM).toBeCloseTo(156.78);
  });

  test('handles null store and flow values', () => {
    const kawabe = observation(kagoshimaBousaiEntries(SAMPLE_ITEMS)[2]);
    expect(kawabe.waterLevelM).toBeNull();
    expect(kawabe.storageVolumeM3).toBeCloseTo(567_000);
    expect(kawabe.inflowM3s).toBeNull();
    expect(kawabe.outflowM3s).toBeNull();
  });

  test('lists nothing for empty items (the portal outside a flood)', () => {
    expect(kagoshimaBousaiEntries([])).toHaveLength(0);
  });

  test('reads the vendor WKT point "POINT(lon lat)" as lat/lng', () => {
    const monnyu = vendor.find((e) => e.name === '門入ダム');
    expect(monnyu?.lat).toBe(34.24903);
    expect(monnyu?.lng).toBe(134.21909);
    expect(observation(monnyu).observedAt.toISOString()).toBe('2026-09-28T03:40:00.000Z');
    expect(observation(monnyu).storageVolumeM3).toBe(1_731_000);
  });

  test('POINT(0 0) is no position, not the Gulf of Guinea', () => {
    const noguchi = vendor.find((e) => e.name === '野口ダム');
    expect(noguchi?.lat).toBeNull();
    expect(noguchi?.lng).toBeNull();
    expect(observation(noguchi).waterLevelM).toBe(249.17);
  });

  test('a station published with every value null is provider-marked empty (粟井)', () => {
    const awai = vendor.find((e) => e.name === '粟井ダム');
    expect((awai?.reading as Reading | undefined)?.state).toBe('empty');
  });

  test('keeps a row that carries only flows', () => {
    const [kawabe] = kagoshimaBousaiEntries([
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
    expect(observation(kawabe).inflowM3s).toBe(3.1);
  });

  test('a missing timestamp is unreadable, not dropped', () => {
    const [e] = kagoshimaBousaiEntries([{ ...(SAMPLE_ITEMS[0] as BousaiItem), obs_datetime: '' }]);
    expect((e?.reading as Reading | undefined)?.state).toBe('unreadable');
  });
});
