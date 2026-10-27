// apps/worker/src/tasks/ingest_nagasaki_kasen.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  type AllDamsJson,
  buildSnapshotUrl,
  type DamMaster,
  nagasakiEntries,
  parseNagasakiDatetime,
} from './ingest_nagasaki_kasen.ts';

function observation(e: Entry | undefined): Observed | undefined {
  const r = e?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
  return r.observations[0];
}

const state = (e: Entry | undefined) =>
  !e || typeof e.reading === 'function' ? undefined : e.reading.state;

describe('parseNagasakiDatetime', () => {
  test('parses "YYYY/MM/DD" + "HH:MM" JST → UTC (subtract 9h)', () => {
    const d = parseNagasakiDatetime('2026/06/05', '15:30');
    expect(d).not.toBeNull();
    // 15:30 JST = 06:30 UTC
    expect(d?.toISOString()).toBe('2026-06-05T06:30:00.000Z');
  });

  test('handles midnight crossover (JST hour < 9 → previous UTC day)', () => {
    const d = parseNagasakiDatetime('2026/06/05', '06:00');
    expect(d).not.toBeNull();
    // 06:00 JST = 2026-06-04T21:00:00Z
    expect(d?.toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  test('returns null for malformed ymd', () => {
    expect(parseNagasakiDatetime('2026-06-05', '15:30')).toBeNull();
    expect(parseNagasakiDatetime('', '15:30')).toBeNull();
  });

  test('returns null for malformed time', () => {
    expect(parseNagasakiDatetime('2026/06/05', '1530')).toBeNull();
    expect(parseNagasakiDatetime('2026/06/05', '')).toBeNull();
  });
});

describe('buildSnapshotUrl', () => {
  test('builds correct URL from max_dt', () => {
    const url = buildSnapshotUrl('https://dam.pref.nagasaki.jp', '2026/06/05 15:30:00');
    expect(url).toBe(
      'https://dam.pref.nagasaki.jp/data/all/202606/20260605/all_20260605_1530_d.json',
    );
  });

  test('handles :00 times', () => {
    const url = buildSnapshotUrl('https://dam.pref.nagasaki.jp', '2026/06/05 09:00:00');
    expect(url).toBe(
      'https://dam.pref.nagasaki.jp/data/all/202606/20260605/all_20260605_0900_d.json',
    );
  });

  test('returns null for malformed max_dt', () => {
    expect(buildSnapshotUrl('https://example.com', 'bad')).toBeNull();
    expect(buildSnapshotUrl('https://example.com', '')).toBeNull();
  });
});

describe('nagasakiEntries — readings', () => {
  const catalogue = [
    { dam_cd: 1928, dam_nm: '永田ダム' },
    { dam_cd: 1927, dam_nm: '勝本ダム' },
    { dam_cd: 1101, dam_nm: '式見ダム' },
  ];

  const sampleJson = {
    ymd: '2026/06/05',
    time: '15:30',
    list: [
      {
        dam_cd: 1928,
        area_cd: 30,
        lv: '64.77',
        pondage: '97',
        rate: '36.7',
        rate_r: '96.2',
        rate_y: '36.6',
        rate_c: '0.0',
        in: '0.01',
        dis: '0.01',
        rain_10: '0',
        rain_h: '0',
        rain_t: '0',
        stat: 2,
        u_lv: '3',
        u_pondage: '3',
        u_rate: '3',
        u_rate_r: '3',
        u_rate_y: '3',
        u_rate_c: '3',
        u_in: '3',
        u_dis: '3',
      },
      {
        dam_cd: 1927,
        area_cd: 30,
        lv: '57.01',
        pondage: '480',
        rate: '38.6',
        rate_r: '95.0',
        rate_y: '38.7',
        rate_c: '0.0',
        in: '0.02',
        dis: '0.03',
        rain_10: '0',
        rain_h: '0',
        rain_t: '0',
        stat: 2,
        u_lv: '3',
        u_pondage: '3',
        u_rate: '3',
        u_rate_r: '3',
        u_rate_y: '3',
        u_rate_c: '3',
        u_in: '3',
        u_dis: '3',
      },
    ],
  };

  const one = (item: Record<string, unknown>) =>
    nagasakiEntries(catalogue.slice(0, 1), {
      ...sampleJson,
      list: [{ ...sampleJson.list[0], ...item }],
    } as AllDamsJson)[0];

  test('first dam has correct values', () => {
    const [e] = nagasakiEntries(catalogue, sampleJson);
    expect(e).toMatchObject({ key: '1928', name: '永田ダム', pref: '42' });
    const o = observation(e);
    // 15:30 JST = 06:30 UTC
    expect(o?.observedAt.toISOString()).toBe('2026-06-05T06:30:00.000Z');
    expect(o?.waterLevelM).toBeCloseTo(64.77);
    expect(o?.storageVolumeM3).toBeCloseTo(97 * 1000);
    // rate_r is the 利水容量貯水率 the manager publishes; `rate` / rate_y
    // divide by the full 有効貯水容量. Issue #38 §2-2.
    expect(o?.storageRate).toBeCloseTo(0.962);
    expect(o?.inflowM3s).toBeCloseTo(0.01);
    expect(o?.outflowM3s).toBeCloseTo(0.01);
  });

  test('storageVolumeM3 is pondage × 1000 (千m³ → m³)', () => {
    const [, katsumoto] = nagasakiEntries(catalogue, sampleJson);
    expect(observation(katsumoto)?.storageVolumeM3).toBeCloseTo(480 * 1000);
  });

  test('a snapshot item missing from the catalogue is not listed', () => {
    const list = nagasakiEntries(catalogue.slice(0, 1), sampleJson);
    expect(list.map((e) => e.key)).toEqual(['1928']);
  });

  test('an unparseable snapshot time leaves every dam unreadable', () => {
    const list = nagasakiEntries(catalogue, { ymd: 'bad', time: 'bad', list: sampleJson.list });
    expect(list.map(state)).toEqual(['unreadable', 'unreadable', 'unreadable']);
  });

  test('empty string fields are unreadable, not provider-marked', () => {
    const e = one({ lv: '', pondage: '', rate: '', rate_r: '', rate_y: '', in: '', dis: '' });
    expect(e?.reading).toEqual({ state: 'unreadable', why: 'no 貯水位 or 貯水量' });
  });

  test('falls back to the 有効容量 rate when 利水 is unpublished', () => {
    expect(observation(one({ rate_r: '-', rate_y: '36.6' }))?.storageRate).toBeCloseTo(0.366);
  });

  test('parses thousands separators in pondage', () => {
    expect(observation(one({ pondage: '1,938' }))?.storageVolumeM3).toBeCloseTo(1_938_000);
  });
});

// Live captures, 2026-09-28: dam_m.json and the 14:10 JST all-dams snapshot.
// 樋口 / つづら / 笛吹 (佐世保市) print 「-」 in every field, stat 0.
const fixture = async (name: string) =>
  Bun.file(`${import.meta.dir}/../../../../tests/fixtures/nagasaki_kasen/${name}`).json();
const liveCatalogue = (await fixture('dam_m_2026-09-28.json')) as DamMaster[];
const liveSnapshot = (await fixture('all_20260928_1410_d.json')) as AllDamsJson;

describe('nagasakiEntries — the live catalogue and snapshot', () => {
  const list = nagasakiEntries(liveCatalogue, liveSnapshot);

  test('lists the whole published catalogue by dam_cd', () => {
    expect(list).toHaveLength(35);
    expect(list.every((e) => e.key === String(Number(e.key)))).toBe(true);
  });

  test('marks the dams printed with 「-」 in every field as provider-marked empty', () => {
    expect(list.filter((e) => state(e) !== 'values').map((e) => [e.name, state(e)])).toEqual([
      ['樋口ダム', 'empty'],
      ['つづらダム', 'empty'],
      ['笛吹ダム', 'empty'],
    ]);
  });

  test('an empty or unreadable field is unreadable, not "no value"', () => {
    const base = liveSnapshot.list.find((i) => i.dam_cd === 1421);
    if (!base) throw new Error('樋口 missing');
    for (const lv of ['', 'x']) {
      const [e] = nagasakiEntries([{ dam_cd: 1421, dam_nm: '樋口ダム' }], {
        ...liveSnapshot,
        list: [{ ...base, lv }],
      });
      expect(state(e)).toBe('unreadable');
    }
  });

  test('a catalogued dam absent from the snapshot is unreadable, not empty', () => {
    const [e] = nagasakiEntries([{ dam_cd: 990002, dam_nm: '試験欠測ダム' }], liveSnapshot);
    expect(e?.reading).toEqual({ state: 'unreadable', why: 'absent from the snapshot' });
  });

  test('a snapshot that could not be read lists the catalogue unreadable', () => {
    const all = nagasakiEntries(liveCatalogue, 'HTTP 503 for dt_range.json');
    expect(all).toHaveLength(35);
    expect(all[0]?.reading).toEqual({ state: 'unreadable', why: 'HTTP 503 for dt_range.json' });
  });

  test("dam_cd 1106 is pinned to 長崎市's 小ヶ倉 (NDI 2609), not its 諫早 namesake", () => {
    // pref 42 has two 小ヶ倉: NDI 2592 (諫早, 長崎県) and NDI 2609 (長崎市).
    expect(list.find((e) => e.key === '1106')?.bind).toEqual({ ndi: '2609' });
    expect(list.filter((e) => e.bind !== undefined)).toHaveLength(1);
  });
});
