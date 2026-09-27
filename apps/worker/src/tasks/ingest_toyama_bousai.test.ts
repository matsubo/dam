// apps/worker/src/tasks/ingest_toyama_bousai.test.ts
//
// Fixtures are verbatim captures of the two CSVs behind 富山県 河川現況表
// (https://kawa.pref.toyama.jp/camera/02condlist.html?id=0&sel=3), taken
// 2026-09-27 at the 16:30 JST update.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  parseToyamaDamData,
  parseToyamaStations,
  type ToyamaStation,
} from './ingest_toyama_bousai.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/toyama');

async function fixture(name: string): Promise<string> {
  return readFile(join(FIXTURES, name), 'utf8');
}

describe('parseToyamaStations', () => {
  test('lists all 16 published dams in page order', async () => {
    const stations = parseToyamaStations(await fixture('damname_data_2026-09-27.csv'));
    expect(stations.map((s) => s.toyamaName)).toEqual([
      '室牧ダム',
      '上市川ダム',
      '和田川ダム',
      '利賀川ダム',
      '白岩川ダム',
      '子撫川ダム',
      '角川ダム',
      '熊野川ダム',
      '上市川第二ダム',
      '朝日小川ダム',
      '布施川ダム',
      '城端ダム',
      '境川ダム',
      '大谷ダム',
      '久婦須川ダム',
      '舟川ダム',
    ]);
    expect(stations[0]?.code).toBe('0040001');
  });

  test('熊野川 and 朝日小川 are the two dams the page prints no 貯水率 for', async () => {
    const stations = parseToyamaStations(await fixture('damname_data_2026-09-27.csv'));
    expect(stations.filter((s) => !s.ratePublished).map((s) => s.toyamaName)).toEqual([
      '熊野川ダム',
      '朝日小川ダム',
    ]);
  });
});

describe('parseToyamaDamData', () => {
  let stations: ToyamaStation[] = [];
  const parse = async () => {
    stations = parseToyamaStations(await fixture('damname_data_2026-09-27.csv'));
    return parseToyamaDamData(await fixture('dam_data_2026-09-27-1630.csv'), stations);
  };

  test('室牧: 貯水率 is the 利水容量 column, stamped with the row own JST time', async () => {
    const r = (await parse()).find((x) => x.toyamaName === '室牧ダム');
    // 16:20 JST on this row while most rows read 16:30.
    expect(r?.observedAt.toISOString()).toBe('2026-09-27T07:20:00.000Z');
    expect(r?.waterLevelM).toBeCloseTo(244.15);
    expect(r?.inflowM3s).toBeCloseTo(4.28);
    expect(r?.outflowM3s).toBeCloseTo(17.23);
    // 利水容量 66.3 %, not 有効容量 36.6 %.
    expect(r?.storageRate).toBeCloseTo(0.663, 6);
  });

  test('大谷: a full 利水 pool reads 1.0 while 有効 reads 4.7 %', async () => {
    const r = (await parse()).find((x) => x.toyamaName === '大谷ダム');
    expect(r?.storageRate).toBeCloseTo(1, 6);
  });

  test('角川: flows are scaled ×10 the way the page renders them', async () => {
    // CSV carries 0.04; the page (and MLIT 川の防災情報 for the same station)
    // shows 0.40 m³/s.
    const r = (await parse()).find((x) => x.toyamaName === '角川ダム');
    expect(r?.inflowM3s).toBeCloseTo(0.4, 6);
    expect(r?.outflowM3s).toBeCloseTo(0.4, 6);
    expect(r?.storageRate).toBeCloseTo(0.978, 6);
  });

  test('舟川: flows are scaled ÷10 to what MLIT reads for the same minute', async () => {
    // CSV 2.11 at 16:30; MLIT 川の防災情報 0.21 at 16:30, Salesforce 0.21 at 16:00.
    const r = (await parse()).find((x) => x.toyamaName === '舟川ダム');
    expect(r?.inflowM3s).toBeCloseTo(0.211, 6);
    expect(r?.outflowM3s).toBeCloseTo(0.211, 6);
  });

  test('熊野川: no 貯水率 where the page prints －, level still kept', async () => {
    const r = (await parse()).find((x) => x.toyamaName === '熊野川ダム');
    expect(r?.waterLevelM).toBeCloseTo(308.52);
    expect(r?.storageRate).toBeNull();
  });

  test('城端 / 利賀川: a 貯水率 held over a 欠測 level is not a reading', async () => {
    // Both print 貯水位 欠測 and no flows, yet the CSV still carries 利水
    // 18.8 / 15.4 %; MLIT flags the same stations' rates missing.
    const names = (await parse()).map((x) => x.toyamaName);
    expect(names).not.toContain('城端ダム');
    expect(names).not.toContain('利賀川ダム');
    expect(names).toHaveLength(14);
  });

  test('a data row for a code missing from the name list is dropped', () => {
    const rows = parseToyamaDamData('9999999,2026/09/27,16:30,1.00,1,1.00,1.00,50.0,20.0,-99.9', [
      { code: '0040001', toyamaName: '室牧ダム', ratePublished: true },
    ]);
    expect(rows).toEqual([]);
  });
});

describe('chooseMaster (#79)', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp });

  test('上市川第二ダム binds 上市川第2, not the 上市川 its stem starts with', () => {
    const masters = [m(9596, '上市川', 1964), m(9595, '上市川第2', 1985)];
    expect(chooseMaster('上市川第二ダム', masters)).toBe(9595n);
    expect(chooseMaster('上市川ダム', masters)).toBe(9596n);
  });

  test('a row already stamped with the station keeps it over a better name match', () => {
    const masters = [m(10, '室牧'), m(20, '室牧発電所', null, '室牧ダム')];
    expect(chooseMaster('室牧ダム', masters)).toBe(20n);
  });

  test('a stamp on two rows is ambiguous, so the name decides', () => {
    const masters = [m(10, '室牧', null, '室牧ダム'), m(20, '室牧発電所', null, '室牧ダム')];
    expect(chooseMaster('室牧ダム', masters)).toBe(10n);
  });

  test('binds the completed （再）, not the lower-id （元）', () => {
    const masters = [m(10, '境川（元）', 1960), m(20, '境川（再）', 1993)];
    expect(chooseMaster('境川ダム', masters)).toBe(20n);
  });

  test('binds the （元） while the （再） has no completion year', () => {
    const masters = [m(10, '境川（再）'), m(20, '境川（元）', 1960)];
    expect(chooseMaster('境川ダム', masters)).toBe(20n);
  });

  test('returns null when no master name contains the stem', () => {
    expect(chooseMaster('熊野川ダム', [m(1, '上市川')])).toBeNull();
  });
});
