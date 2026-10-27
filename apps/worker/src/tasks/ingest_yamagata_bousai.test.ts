// apps/worker/src/tasks/ingest_yamagata_bousai.test.ts
//
// Feed JSON → universe entries, no database: binding and writing belong to
// the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Reading } from '../ingest/types.ts';
import {
  parseYamagataTimestamp,
  type YamagataJson,
  yamagataEntries,
} from './ingest_yamagata_bousai.ts';

function observation(e: Entry | undefined) {
  const r = e?.reading as Reading | undefined;
  if (r?.state !== 'values') throw new Error('no values');
  const o = r.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

describe('parseYamagataTimestamp', () => {
  test('parses JST timestamp to UTC (subtract 9h)', () => {
    const d = parseYamagataTimestamp('20260605133000');
    expect(d).not.toBeNull();
    // 13:30 JST = 04:30 UTC same day
    expect(d?.toISOString()).toBe('2026-06-05T04:30:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseYamagataTimestamp('20260605080000');
    expect(d).not.toBeNull();
    // 08:00 JST = -1:00 UTC → JS normalizes to 2026-06-04T23:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T23:00:00.000Z');
  });

  test('returns null for malformed string', () => {
    expect(parseYamagataTimestamp('bad')).toBeNull();
    expect(parseYamagataTimestamp('')).toBeNull();
    expect(parseYamagataTimestamp('2026/06/05 13:30')).toBeNull();
  });
});

describe('yamagataEntries', () => {
  function makeEntry(
    an: string,
    data1: string,
    data2: string,
    data3: string,
    data4: string,
    data5: string,
    time = '20260605133000',
  ) {
    return { an, data1, data2, data3, data4, data5, time };
  }

  function makeJson(entries: Record<string, ReturnType<typeof makeEntry>>): YamagataJson {
    return { date: '20260605133000', ...entries };
  }

  test('extracts all fields from a typical dam entry', () => {
    const json = makeJson({
      '1': makeEntry('蔵王ダム', '599.27', '4858', '1.80', '1.27', '86.4'),
    });
    const list = yamagataEntries(json);
    expect(list).toHaveLength(1);
    expect(list[0]?.key).toBe('蔵王ダム');
    expect(list[0]?.name).toBe('蔵王ダム');
    expect(list[0]?.pref).toBe('06');
    const r = observation(list[0]);
    expect(r?.observedAt?.toISOString()).toBe('2026-06-05T04:30:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(599.27);
    // 4858 千m³ × 1000 = 4,858,000 m³
    expect(r?.storageVolumeM3).toBe(4_858_000);
    // 86.4 / 100 = 0.864
    expect(r?.storageRate).toBeCloseTo(0.864);
    expect(r?.inflowM3s).toBeCloseTo(1.8);
    expect(r?.outflowM3s).toBeCloseTo(1.27);
  });

  test('parses multiple dams, skips "date" key', () => {
    const json = makeJson({
      '1': makeEntry('蔵王ダム', '599.27', '4858', '1.80', '1.27', '86.4'),
      '2': makeEntry('前川ダム', '256.74', '1394', '0.05', '0.05', '82.0'),
    });
    expect(yamagataEntries(json).map((e) => e.key)).toEqual(['蔵王ダム', '前川ダム']);
  });

  test('uses per-dam time when present', () => {
    const json = makeJson({
      '1': makeEntry('蔵王ダム', '599.27', '4858', '1.80', '1.27', '86.4', '20260605120000'),
    });
    // 12:00 JST = 03:00 UTC
    expect(observation(yamagataEntries(json)[0]).observedAt.toISOString()).toBe(
      '2026-06-05T03:00:00.000Z',
    );
  });

  test('falls back to feed date when per-dam time is missing', () => {
    const json = {
      date: '20260605133000',
      '1': {
        an: '蔵王ダム',
        data1: '599.27',
        data2: '4858',
        data3: '1.80',
        data4: '1.27',
        data5: '86.4',
      },
    };
    const list = yamagataEntries(json as unknown as YamagataJson);
    expect(observation(list[0]).observedAt.toISOString()).toBe('2026-06-05T04:30:00.000Z');
  });

  test('treats empty string fields as null', () => {
    const json = makeJson({
      '1': makeEntry('荒沢ダム', '', '23897', '24.96', '', '82.8'),
    });
    const r = observation(yamagataEntries(json)[0]);
    expect(r.waterLevelM).toBeNull();
    expect(r.outflowM3s).toBeNull();
    expect(r.storageVolumeM3).toBe(23_897_000);
  });

  test('a dam blank or dashed in every field is provider-marked empty', () => {
    const json = makeJson({ '1': makeEntry('荒沢ダム', '', '---', '-', '―', '') });
    expect((yamagataEntries(json)[0]?.reading as Reading | undefined)?.state).toBe('empty');
  });

  test('an unparseable timestamp is unreadable, not dropped', () => {
    const json = makeJson({
      '1': makeEntry('蔵王ダム', '599.27', '4858', '1.80', '1.27', '86.4', 'bad'),
    });
    expect((yamagataEntries(json)[0]?.reading as Reading | undefined)?.state).toBe('unreadable');
  });

  test('skips entry with no dam name', () => {
    const json = makeJson({
      '1': makeEntry('', '599.27', '4858', '1.80', '1.27', '86.4'),
    });
    expect(yamagataEntries(json)).toHaveLength(0);
  });

  test('handles numeric gaps (missing keys 15-17) gracefully — only iterates present keys', () => {
    const json = makeJson({
      '14': makeEntry('田沢川ダム', '130.94', '4988', '1.40', '0.65', '100.0'),
      '18': makeEntry('寒河江ダム', '389.80', '62707', '27.31', '27.23', '70.7'),
    });
    expect(yamagataEntries(json).map((e) => e.key)).toEqual(['田沢川ダム', '寒河江ダム']);
  });

  test('storageRate is clamped to [0,1] via division (not clamping — trust source)', () => {
    // 100.0% → 1.0
    const json = makeJson({
      '1': makeEntry('留山川ダム', '300.00', '339', '0.05', '0.05', '100.0'),
    });
    expect(observation(yamagataEntries(json)[0]).storageRate).toBeCloseTo(1.0);
  });

  test('storage 0 (流水型ダム) yields storageVolumeM3=0', () => {
    const json = makeJson({
      '7': makeEntry('最上小国川流水型ダム', '276.78', '1', '1.63', '1.63', '0.0'),
    });
    const r = observation(yamagataEntries(json)[0]);
    expect(r.storageVolumeM3).toBe(1_000); // 1千m³ × 1000
    expect(r.storageRate).toBeCloseTo(0.0);
  });
});
