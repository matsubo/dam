import { describe, expect, test } from 'bun:test';
import { parseSaitamaCsv, parseSaitamaTimestamp } from './ingest_saitama_suibo.ts';

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

describe('parseSaitamaCsv', () => {
  test('parses all 9 known dam rows', () => {
    const rows = parseSaitamaCsv(SAMPLE_CSV);
    expect(rows).toHaveLength(9);
  });

  test('station names are mapped correctly', () => {
    const rows = parseSaitamaCsv(SAMPLE_CSV);
    expect(rows.map((r) => r.saitamaName)).toEqual([
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

  test('合角ダム: all fields parsed correctly', () => {
    const r = parseSaitamaCsv(SAMPLE_CSV).find((x) => x.saitamaName === '合角ダム');
    expect(r).toBeDefined();
    expect(r?.observedAt.toISOString()).toBe('2026-06-05T12:30:00.000Z');
    expect(r?.outflowM3s).toBeCloseTo(0.1);
    expect(r?.inflowM3s).toBeCloseTo(0.66);
    expect(r?.waterLevelM).toBeCloseTo(315.17);
    expect(r?.storageVolumeM3).toBeCloseTo(4_518_000);
  });

  test('storageVolumeM3 = ×1000 with comma-stripped number (浦山ダム: 28,559×1000)', () => {
    const r = parseSaitamaCsv(SAMPLE_CSV).find((x) => x.saitamaName === '浦山ダム');
    expect(r?.storageVolumeM3).toBeCloseTo(28_559_000);
  });

  test('"c" values parse as null', () => {
    const r = parseSaitamaCsv(SAMPLE_CSV).find((x) => x.saitamaName === '渡良瀬遊水地');
    expect(r?.outflowM3s).toBeNull();
    expect(r?.inflowM3s).toBeNull();
    // waterLevel is not null so row is not skipped
    expect(r?.waterLevelM).toBeCloseTo(11.75);
  });

  test('"*" values parse as null (荒川第一調節池)', () => {
    const r = parseSaitamaCsv(SAMPLE_CSV).find((x) => x.saitamaName === '荒川第一調節池');
    expect(r?.outflowM3s).toBeNull();
    expect(r?.inflowM3s).toBeNull();
    expect(r?.waterLevelM).toBeCloseTo(3.15);
  });

  test('unknown station code is ignored', () => {
    const csv = '99999999999,1,"1.0","2.0","100.0","500","50.0",202606052130,unknown\n';
    expect(parseSaitamaCsv(csv)).toHaveLength(0);
  });

  test('returns empty array for empty input', () => {
    expect(parseSaitamaCsv('')).toHaveLength(0);
    expect(parseSaitamaCsv('\n\n')).toHaveLength(0);
  });

  test('row with all null measurements is skipped', () => {
    const csv = '55301100001,1,c,c,,c,"50.0",202606052130,秩父県土整備事務所\n';
    expect(parseSaitamaCsv(csv)).toHaveLength(0);
  });
});
