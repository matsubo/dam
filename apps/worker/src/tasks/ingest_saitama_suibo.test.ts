// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import type { Reading } from '../ingest/types.ts';
import { parseSaitamaTimestamp, saitamaEntries } from './ingest_saitama_suibo.ts';

function observation(text: string, name: string) {
  const r = saitamaEntries(text).find((e) => e.name === name)?.reading as Reading | undefined;
  if (r?.state !== 'values') throw new Error(`${name}: no values`);
  const o = r.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

const stateOf = (text: string, code: string) =>
  (saitamaEntries(text).find((e) => e.key === code)?.reading as Reading | undefined)?.state;

describe('parseSaitamaTimestamp', () => {
  test('parses "YYYYMMDDHHmm" (JST) → UTC', () => {
    const d = parseSaitamaTimestamp('202606052130');
    expect(d?.toISOString()).toBe('2026-06-05T12:30:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseSaitamaTimestamp('202606050000');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for wrong length', () => {
    expect(parseSaitamaTimestamp('2026060521')).toBeNull();
    expect(parseSaitamaTimestamp('')).toBeNull();
    expect(parseSaitamaTimestamp('20260605213099')).toBeNull();
  });

  test('returns null for NaN values', () => {
    expect(parseSaitamaTimestamp('202606XX2130')).toBeNull();
  });
});

// Sample CSV matching the actual dinfo.csv format (UTF-8, no header)
const SAMPLE_CSV = `55301100001,1,"0.10","0.66","315.17","4,518","38.0",202606052130,秩父県土整備事務所
55301100002,1,"0.81","0.92","301.70","4,831","61.8",202606052130,飯能県土整備事務所
55301100003,1,"0.54","0.45","5.45","1,016","16.3",202606052130,杉戸県土整備事務所
12330100001,0,c,c,"11.75","13,242","50.2",202606052130,(国)利根川上流河川事務所
12331600001,0,"0.00","3.72","527.55","9,468","49.6",202606052130,(国)二瀬ダム管理所
12330800004,0,*,*,"3.15","9,326","91.4",202606052130,(国)荒川上流河川事務所
12330800005,0,"0.73","2.71","366.96","28,559","51.0",202606052130,(国)荒川上流河川事務所
12330800006,0,"0.53","3.74","534.37","22,639","39.0",202606052130,(国)荒川上流河川事務所
12331400006,0,"8.24","8.24","259.47","37,180","31.0",202606052120,(国)利根川ダム統合管理事務所
`;

describe('saitamaEntries', () => {
  test('lists all 9 mapped stations, keyed by 地点番号, every one with values', () => {
    const list = saitamaEntries(SAMPLE_CSV);
    expect(list).toHaveLength(9);
    expect(list.every((e) => (e.reading as Reading).state === 'values')).toBe(true);
    expect(list[0]?.key).toBe('55301100001');
    expect(list[0]?.pref).toBe('11');
  });

  test('looks up the border stations in the neighbouring prefectures too', () => {
    const list = saitamaEntries(SAMPLE_CSV);
    expect(list.find((e) => e.name === '渡良瀬遊水地')?.pref).toEqual(['11', '09', '10', '13']);
    expect(list.find((e) => e.name === '下久保ダム')?.pref).toEqual(['11', '09', '10', '13']);
  });

  test('station names are mapped correctly', () => {
    expect(saitamaEntries(SAMPLE_CSV).map((e) => e.name)).toEqual([
      '合角ダム',
      '有間ダム',
      '権現堂調節池',
      '渡良瀬遊水地',
      '二瀬ダム',
      '荒川第一調節池',
      '浦山ダム',
      '滝沢ダム',
      '下久保ダム',
    ]);
  });

  test('binds 荒川第一調節池 by the master name 荒川調節池', () => {
    const list = saitamaEntries(SAMPLE_CSV);
    expect(list.find((e) => e.name === '荒川第一調節池')?.bind).toEqual({ name: '荒川調節池' });
    expect(list.find((e) => e.name === '浦山ダム')?.bind).toBeUndefined();
  });

  test('合角ダム: all fields parsed correctly', () => {
    const r = observation(SAMPLE_CSV, '合角ダム');
    expect(r.observedAt.toISOString()).toBe('2026-06-05T12:30:00.000Z');
    expect(r.outflowM3s).toBeCloseTo(0.1);
    expect(r.inflowM3s).toBeCloseTo(0.66);
    expect(r.waterLevelM).toBeCloseTo(315.17);
    expect(r.storageVolumeM3).toBeCloseTo(4_518_000);
  });

  test('storageVolumeM3 = ×1000 with comma-stripped number (浦山ダム: 28,559×1000)', () => {
    expect(observation(SAMPLE_CSV, '浦山ダム').storageVolumeM3).toBeCloseTo(28_559_000);
  });

  test('"c" values parse as null', () => {
    const r = observation(SAMPLE_CSV, '渡良瀬遊水地');
    expect(r.outflowM3s).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.waterLevelM).toBeCloseTo(11.75);
  });

  test('"*" values parse as null (荒川第一調節池)', () => {
    const r = observation(SAMPLE_CSV, '荒川第一調節池');
    expect(r.outflowM3s).toBeNull();
    expect(r.inflowM3s).toBeNull();
    expect(r.waterLevelM).toBeCloseTo(3.15);
  });

  test('unknown station code is ignored', () => {
    const csv = '99999999999,1,"1.0","2.0","100.0","500","50.0",202606052130,unknown\n';
    expect(saitamaEntries(csv).map((e) => e.key)).not.toContain('99999999999');
  });

  test('a mapped station missing from the CSV is unreadable, not dropped', () => {
    expect(stateOf('', '55301100001')).toBe('unreadable');
    expect(saitamaEntries('\n\n')).toHaveLength(9);
  });

  test('a row marked c / blank in every column is provider-marked empty', () => {
    const csv = '55301100001,1,c,c,,c,"50.0",202606052130,秩父県土整備事務所\n';
    expect(stateOf(csv, '55301100001')).toBe('empty');
  });

  test('an unparseable 観測時刻 is unreadable', () => {
    const csv = '55301100001,1,"0.10","0.66","315.17","4,518","38.0",bad,秩父県土整備事務所\n';
    expect(stateOf(csv, '55301100001')).toBe('unreadable');
  });
});
