// apps/worker/src/tasks/ingest_nagano_kasen.test.ts
//
// Sample JSON → universe entries, no database: binding and writing belong to
// the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import { buildNaganoUrl, naganoEntries, parseNaganoTimestamp } from './ingest_nagano_kasen.ts';

function observation(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}

const state = (e: Entry | undefined) =>
  !e || typeof e.reading === 'function' ? undefined : e.reading.state;

describe('parseNaganoTimestamp', () => {
  test('parses "YYYY-MM-DD-HH-mm" (JST) → UTC', () => {
    const d = parseNaganoTimestamp('2026-06-05-20-00');
    expect(d?.toISOString()).toBe('2026-06-05T11:00:00.000Z');
  });

  test('handles midnight crossover (JST 00:00 → previous UTC day)', () => {
    const d = parseNaganoTimestamp('2026-06-05-00-00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed input', () => {
    expect(parseNaganoTimestamp('')).toBeNull();
    expect(parseNaganoTimestamp('2026-06-05')).toBeNull();
    expect(parseNaganoTimestamp('bad')).toBeNull();
  });
});

describe('buildNaganoUrl', () => {
  test('generates correct URL using JST date', () => {
    // 2026-06-05 17:00 UTC = 2026-06-06 02:00 JST → date 20260606
    const url = buildNaganoUrl(
      new Date('2026-06-05T17:00:00.000Z'),
      'https://www.sabo-nagano.jp/dyn/json/dat/pc',
    );
    expect(url).toBe('https://www.sabo-nagano.jp/dyn/json/dat/pc/20260606/20260606_1_dam_60.json');
  });

  test('same-day when UTC still within JST date', () => {
    // 2026-06-05 08:00 UTC = 2026-06-05 17:00 JST → date 20260605
    const url = buildNaganoUrl(
      new Date('2026-06-05T08:00:00.000Z'),
      'https://www.sabo-nagano.jp/dyn/json/dat/pc',
    );
    expect(url).toBe('https://www.sabo-nagano.jp/dyn/json/dat/pc/20260605/20260605_1_dam_60.json');
  });
});

// Sample JSON — uses "value"/"level" (not "val"/"lvl" like Fukushima).
// Includes 釜口水門 (2001_7_3), a sluice gate.
const SAMPLE_JSON = {
  observationTime: '2026-06-05-20-00',
  updateTime: '2026-06-05-20-59',
  // 松川ダム: all fields present
  '2001_7_1': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '681.32', level: 0 },
        item_20: { value: '446', level: 0 },
        item_50: { value: '2.47', level: 0 },
        item_70: { value: '2.50', level: 0 },
      },
    ],
  },
  // 横川ダム: missing storage volume ("--")
  '2001_7_5': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '903.09', level: 2 },
        item_20: { value: '--', level: -3 },
        item_50: { value: '1.47', level: 0 },
        item_70: { value: '1.47', level: 0 },
      },
    ],
  },
  // 釜口水門: sluice gate — listed, never bound
  '2001_7_3': {
    data60: [
      {
        time: '2026-06-05-20-00',
        item_10: { value: '762.44', level: 0 },
      },
    ],
  },
};

describe('naganoEntries', () => {
  const list = naganoEntries(SAMPLE_JSON);
  const byName = (name: string) => list.find((e) => e.name === name);

  test('lists every station of the map by id, reported or not', () => {
    expect(list).toHaveLength(18);
    expect(list[0]).toMatchObject({ key: '2001_7_1', name: '松川ダム', pref: '20' });
    expect(state(byName('片桐ダム'))).toBe('unreadable');
  });

  test('釜口水門 is listed but never bound', () => {
    expect(byName('釜口水門')).toMatchObject({ key: '2001_7_3', bind: 'never' });
    expect(list.filter((e) => e.bind !== undefined)).toHaveLength(1);
  });

  test('observedAt converted from JST to UTC', () => {
    for (const name of ['松川ダム', '横川ダム']) {
      expect(observation(byName(name))?.observedAt.toISOString()).toBe('2026-06-05T11:00:00.000Z');
    }
  });

  test('松川ダム: storage volume multiplied by 1000', () => {
    const o = observation(byName('松川ダム'));
    expect(o?.waterLevelM).toBeCloseTo(681.32);
    expect(o?.storageVolumeM3).toBeCloseTo(446_000);
    expect(o?.inflowM3s).toBeCloseTo(2.47);
    expect(o?.outflowM3s).toBeCloseTo(2.5);
  });

  test('横川ダム: "--" storage volume → null', () => {
    const o = observation(byName('横川ダム'));
    expect(o?.waterLevelM).toBeCloseTo(903.09);
    expect(o?.storageVolumeM3).toBeNull();
    expect(o?.inflowM3s).toBeCloseTo(1.47);
  });

  test('a station marked on every field is provider-marked empty', () => {
    const marked = { value: '--', level: -3 };
    const [matsukawa] = naganoEntries({
      '2001_7_1': {
        data60: [
          {
            time: '2026-06-05-20-00',
            item_10: marked,
            item_20: marked,
            item_50: marked,
            item_70: marked,
          },
        ],
      },
    });
    expect(matsukawa?.reading).toEqual({ state: 'empty', mark: '* / -- on every field' });
  });

  test('an unreadable hour file lists every station unreadable', () => {
    const all = naganoEntries(null, 'HTTP 404');
    expect(all).toHaveLength(18);
    expect(all[0]?.reading).toEqual({ state: 'unreadable', why: 'HTTP 404' });
  });
});
