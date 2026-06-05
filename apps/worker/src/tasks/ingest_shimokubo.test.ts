// apps/worker/src/tasks/ingest_shimokubo.test.ts

import { describe, expect, test } from 'bun:test';
import {
  type ParsedReading,
  parseShimokuboJson,
  parseShimokuboTimestamp,
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

describe('parseShimokuboJson', () => {
  function makeRecord(name: string, data10: string, data60 = data10) {
    return {
      name,
      datas: [
        { data10: '0', data60: '0' }, // older point
        { data10: data10, data60: data60 }, // latest
      ],
    };
  }

  function makeJson(records: ReturnType<typeof makeRecord>[]) {
    return {
      update_time: '2026/06/05 11:30',
      times: [
        { time60: '2026/06/04 12:00', time10: '2026/06/05 07:00' },
        { time60: '2026/06/05 11:00', time10: '2026/06/05 11:30' },
      ],
      records,
    };
  }

  test('extracts all fields from typical live data', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', '259.36'),
      makeRecord('下久保ダム有効容量内貯水量', '37010'),
      makeRecord('下久保ダム有効容量内貯水率', '30.8'),
      makeRecord('下久保ダム全流入量', '10.31'),
      makeRecord('下久保ダム全放流量', '8.60'),
    ]);

    const r = parseShimokuboJson(json);

    expect(r.observedAt?.toISOString()).toBe('2026-06-05T02:30:00.000Z');
    expect(r.waterLevelM).toBeCloseTo(259.36);
    // 37010 千m³ × 1000 = 37,010,000 m³
    expect(r.storageVolumeM3).toBe(37_010_000);
    // 30.8 / 100 = 0.308
    expect(r.storageRate).toBeCloseTo(0.308);
    expect(r.inflowM3s).toBeCloseTo(10.31);
    expect(r.outflowM3s).toBeCloseTo(8.6);
  });

  test('uses the last datas element (latest 10-min reading)', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', '259.99'), // latest = '259.99', oldest = '0'
      makeRecord('下久保ダム有効容量内貯水量', '40000'),
      makeRecord('下久保ダム有効容量内貯水率', '33.3'),
      makeRecord('下久保ダム全流入量', '5.00'),
      makeRecord('下久保ダム全放流量', '5.00'),
    ]);
    const r = parseShimokuboJson(json);
    expect(r.waterLevelM).toBeCloseTo(259.99);
  });

  test('treats empty string and non-numeric as null', () => {
    const json = makeJson([
      makeRecord('下久保ダム貯水位', ''),
      makeRecord('下久保ダム有効容量内貯水量', '37010'),
      makeRecord('下久保ダム有効容量内貯水率', '30.8'),
      makeRecord('下久保ダム全流入量', '―'),
      makeRecord('下久保ダム全放流量', '8.60'),
    ]);
    const r = parseShimokuboJson(json);
    expect(r.waterLevelM).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.storageVolumeM3).toBe(37_010_000);
  });

  test('returns null observedAt when update_time is malformed', () => {
    const json = makeJson([]);
    (json as { update_time: string }).update_time = 'invalid';
    const r = parseShimokuboJson(json);
    expect(r.observedAt).toBeNull();
  });

  test('handles missing record names gracefully (returns null fields)', () => {
    const json = makeJson([]); // no records at all
    const r: ParsedReading = parseShimokuboJson(json);
    expect(r.waterLevelM).toBeNull();
    expect(r.storageVolumeM3).toBeNull();
    expect(r.storageRate).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.outflowM3s).toBeNull();
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
    const r = parseShimokuboJson(json);
    expect(r.waterLevelM).toBeCloseTo(259.1);
  });
});
