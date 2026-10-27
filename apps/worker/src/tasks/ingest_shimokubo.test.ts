// apps/worker/src/tasks/ingest_shimokubo.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Reading } from '../ingest/types.ts';
import { fixtureUpstream } from '../ingest/upstream.ts';
import {
  parseShimokuboTimestamp,
  type ShimokuboJson,
  shimokuboEntries,
  shimokuboReading,
} from './ingest_shimokubo.ts';

describe('parseShimokuboTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseShimokuboTimestamp('2026/06/05 11:30');
    expect(d).not.toBeNull();
    // 11:30 JST = 02:30 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T02:30:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseShimokuboTimestamp('2026/06/05 08:00');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → JS normalizes to 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseShimokuboTimestamp('bad input')).toBeNull();
    expect(parseShimokuboTimestamp('')).toBeNull();
  });
});

function makeRecord(name: string, data10: string, data60 = data10) {
  return {
    name,
    datas: [
      { data10: '0', data60: '0' }, // older point
      { data10: data10, data60: data60 }, // latest
    ],
  };
}

function makeJson(records: ReturnType<typeof makeRecord>[]): ShimokuboJson {
  return {
    update_time: '2026/06/05 11:30',
    times: [
      { time60: '2026/06/04 12:00', time10: '2026/06/05 07:00' },
      { time60: '2026/06/05 11:00', time10: '2026/06/05 11:30' },
    ],
    records,
  };
}

function observed(r: Reading) {
  if (r.state !== 'values') throw new Error(`expected values, got ${r.state}`);
  const [o] = r.observations;
  if (!o) throw new Error('no observation');
  return o;
}

const TYPICAL = makeJson([
  makeRecord('下久保ダム貯水位', '259.36'),
  makeRecord('下久保ダム有効容量内貯水量', '37010'),
  makeRecord('下久保ダム有効容量内貯水率', '30.8'),
  makeRecord('下久保ダム全流入量', '10.31'),
  makeRecord('下久保ダム全放流量', '8.60'),
]);

describe('shimokuboReading', () => {
  test('extracts all fields from typical live data', () => {
    const o = observed(shimokuboReading(TYPICAL));
    expect(o.observedAt.toISOString()).toBe('2026-06-05T02:30:00.000Z');
    expect(o.waterLevelM).toBeCloseTo(259.36);
    // 37010 千m³ × 1000 = 37,010,000 m³
    expect(o.storageVolumeM3).toBe(37_010_000);
    // 30.8 / 100 = 0.308
    expect(o.storageRate).toBeCloseTo(0.308);
    expect(o.inflowM3s).toBeCloseTo(10.31);
    expect(o.outflowM3s).toBeCloseTo(8.6);
  });

  test('uses the last datas element (latest 10-min reading)', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', '259.99'), // latest = '259.99', oldest = '0'
      makeRecord('下久保ダム有効容量内貯水量', '40000'),
      makeRecord('下久保ダム有効容量内貯水率', '33.3'),
      makeRecord('下久保ダム全流入量', '5.00'),
      makeRecord('下久保ダム全放流量', '5.00'),
    ]);
    expect(observed(shimokuboReading(json)).waterLevelM).toBeCloseTo(259.99);
  });

  test('treats empty string and non-numeric as null', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', ''),
      makeRecord('下久保ダム有効容量内貯水量', '37010'),
      makeRecord('下久保ダム有効容量内貯水率', '30.8'),
      makeRecord('下久保ダム全流入量', '―'),
      makeRecord('下久保ダム全放流量', '8.60'),
    ]);
    const o = observed(shimokuboReading(json));
    expect(o.waterLevelM).toBeNull();
    expect(o.inflowM3s).toBeNull();
    expect(o.storageVolumeM3).toBe(37_010_000);
  });

  test('"―" on both 貯水位 and 貯水量 is provider-marked empty', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', '―'),
      makeRecord('下久保ダム有効容量内貯水量', '―'),
      makeRecord('下久保ダム全流入量', '5.00'),
    ]);
    expect(shimokuboReading(json).state).toBe('empty');
  });

  test('a malformed update_time is unreadable', () => {
    expect(shimokuboReading({ ...TYPICAL, update_time: 'invalid' }).state).toBe('unreadable');
  });

  test('missing record names are unreadable', () => {
    expect(shimokuboReading(makeJson([])).state).toBe('unreadable');
  });

  test('duplicate record names: uses the first match', () => {
    // Both have the same name; adapter should pick the first one
    const json = makeJson([
      makeRecord('下久保ダム貯水位', '259.10'),
      makeRecord('下久保ダム貯水位', '260.00'), // should be ignored
      makeRecord('下久保ダム有効容量内貯水量', '36000'),
      makeRecord('下久保ダム有効容量内貯水率', '30.0'),
      makeRecord('下久保ダム全流入量', '7.00'),
      makeRecord('下久保ダム全放流量', '7.00'),
    ]);
    expect(observed(shimokuboReading(json)).waterLevelM).toBeCloseTo(259.1);
  });
});

describe('shimokuboEntries', () => {
  test('lists 下久保ダム by name, searched in 群馬 and 埼玉', async () => {
    const [entry, ...rest] = shimokuboEntries(fixtureUpstream(() => JSON.stringify(TYPICAL)));
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ key: '下久保ダム', name: '下久保ダム', pref: ['10', '11'] });
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    expect((await entry.reading(null)).state).toBe('values');
  });

  test('a feed that fails to load makes the reading throw (the run records it unreadable)', async () => {
    const [entry] = shimokuboEntries(fixtureUpstream(() => ({ status: 503 })));
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(entry.reading(null))).rejects.toThrow('HTTP 503');
  });
});
