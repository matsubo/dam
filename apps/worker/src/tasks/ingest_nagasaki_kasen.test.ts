// apps/worker/src/tasks/ingest_nagasaki_kasen.test.ts

import { describe, expect, test } from 'bun:test';
import {
  type ParsedRow,
  buildSnapshotUrl,
  parseAllDamsJson,
  parseNagasakiDatetime,
} from './ingest_nagasaki_kasen.ts';

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

describe('parseAllDamsJson', () => {
  const masters = new Map<number, string>([
    [1928, '永田ダム'],
    [1927, '勝本ダム'],
    [1101, '式見ダム'],
  ]);

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

  test('parses two dams with all fields', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows).toHaveLength(2);
  });

  test('first dam has correct values', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows[0]?.damName).toBe('永田ダム');
    expect(rows[0]?.damCd).toBe(1928);
    // 15:30 JST = 06:30 UTC
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-06-05T06:30:00.000Z');
    expect(rows[0]?.waterLevelM).toBeCloseTo(64.77);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(97 * 1000);
    // rate_r is the 利水容量貯水率 the manager publishes; `rate` / rate_y
    // divide by the full 有効貯水容量. Issue #38 §2-2.
    expect(rows[0]?.storageRate).toBeCloseTo(0.962);
    expect(rows[0]?.inflowM3s).toBeCloseTo(0.01);
    expect(rows[0]?.outflowM3s).toBeCloseTo(0.01);
  });

  test('storageVolumeM3 is pondage × 1000 (千m³ → m³)', () => {
    const rows = parseAllDamsJson(sampleJson, masters);
    expect(rows[1]?.storageVolumeM3).toBeCloseTo(480 * 1000);
  });

  test('skips dams not in master map', () => {
    const singleMaster = new Map<number, string>([[1928, '永田ダム']]);
    const rows = parseAllDamsJson(sampleJson, singleMaster);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.damName).toBe('永田ダム');
  });

  test('returns empty array when observedAt is unparseable', () => {
    const bad = { ymd: 'bad', time: 'bad', list: sampleJson.list };
    expect(parseAllDamsJson(bad, masters)).toHaveLength(0);
  });

  test('handles empty string fields as null', () => {
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [
        {
          dam_cd: 1101,
          area_cd: 10,
          lv: '',
          pondage: '',
          rate: '',
          rate_r: '',
          rate_y: '',
          rate_c: '',
          in: '',
          dis: '',
          rain_10: '0',
          rain_h: '0',
          rain_t: '0',
          stat: 0,
          u_lv: '0',
          u_pondage: '0',
          u_rate: '0',
          u_rate_r: '0',
          u_rate_y: '0',
          u_rate_c: '0',
          u_in: '0',
          u_dis: '0',
        },
      ],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.waterLevelM).toBeNull();
    expect(rows[0]?.storageVolumeM3).toBeNull();
    expect(rows[0]?.storageRate).toBeNull();
    expect(rows[0]?.inflowM3s).toBeNull();
    expect(rows[0]?.outflowM3s).toBeNull();
  });

  test('falls back to the 有効容量 rate when 利水 is unpublished', () => {
    const [base] = sampleJson.list;
    if (!base) throw new Error('fixture missing');
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [{ ...base, rate_r: '-', rate_y: '36.6' }],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows[0]?.storageRate).toBeCloseTo(0.366);
  });

  test('parses thousands separators in pondage', () => {
    const [base] = sampleJson.list;
    if (!base) throw new Error('fixture missing');
    const json = {
      ymd: '2026/06/05',
      time: '15:30',
      list: [{ ...base, pondage: '1,938' }],
    };
    const rows = parseAllDamsJson(json, masters);
    expect(rows[0]?.storageVolumeM3).toBeCloseTo(1_938_000);
  });
});
