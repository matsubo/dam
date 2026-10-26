// apps/worker/src/tasks/ingest_qsr_ryumon.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// LIVE holds the six key answers as captured 2026-10-27 00:40 JST.

import { describe, expect, test } from 'bun:test';
import {
  parseRyumonTimestamp,
  type RyumonKey,
  ryumonEntries,
  ryumonReading,
} from './ingest_qsr_ryumon.ts';

const LIVE: Record<RyumonKey, string> = {
  time_kansoku: '2026/10/27 00:40',
  dam_ryunyu: '1.93m3/s',
  dam_houryu: '1.03m3/s',
  dam_chosuiryo: '12396.00千m3',
  dam_chosuii: '249.13m',
  dam_chosuiritsu: '37.00％',
};

describe('parseRyumonTimestamp', () => {
  test('parses JST timestamp to UTC', () => {
    const d = parseRyumonTimestamp('2026/06/05 19:50');
    expect(d?.toISOString()).toBe('2026-06-05T10:50:00.000Z');
    expect(d?.getUTCHours()).toBe(10);
    expect(d?.getUTCMinutes()).toBe(50);
  });

  test('parses midnight JST (UTC previous day)', () => {
    const d = parseRyumonTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for empty input', () => {
    expect(parseRyumonTimestamp('')).toBeNull();
  });

  test('returns null for malformed input', () => {
    expect(parseRyumonTimestamp('bad')).toBeNull();
    expect(parseRyumonTimestamp('2026/6/5 19:50')).toBeNull(); // missing zero-padding
  });
});

describe('ryumonReading', () => {
  test('reads flows, level, 千m³ volume and the 貯水率 fraction, units stripped', () => {
    expect(ryumonReading(LIVE)).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: new Date('2026-10-26T15:40:00.000Z'),
          storageVolumeM3: 12_396_000,
          storageRate: 0.37,
          inflowM3s: 1.93,
          outflowM3s: 1.03,
          waterLevelM: 249.13,
        },
      ],
    });
  });

  test('欠測 on every stored key is provider-marked empty', () => {
    const r = ryumonReading({
      ...LIVE,
      dam_ryunyu: '欠測',
      dam_houryu: '欠測',
      dam_chosuiryo: '欠測',
      dam_chosuii: '欠測',
    });
    expect(r.state).toBe('empty');
  });

  test('an unparseable time_kansoku is unreadable', () => {
    expect(ryumonReading({ ...LIVE, time_kansoku: '' }).state).toBe('unreadable');
  });
});

describe('ryumonEntries', () => {
  test('lists 竜門ダム by name in 福岡 and reads it from the six keys', async () => {
    const [entry, ...rest] = ryumonEntries(async (k) => LIVE[k]);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ key: '竜門ダム', name: '竜門ダム', pref: '40' });
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    expect((await entry.reading(null)).state).toBe('values');
  });

  test('a key that fails to load makes the reading throw (the run records it unreadable)', async () => {
    const [entry] = ryumonEntries((k) =>
      k === 'dam_houryu' ? Promise.reject(new Error('HTTP 500')) : Promise.resolve(LIVE[k]),
    );
    if (typeof entry?.reading !== 'function') throw new Error('expected a reading function');
    await expect(Promise.resolve(entry.reading(null))).rejects.toThrow('HTTP 500');
  });
});
