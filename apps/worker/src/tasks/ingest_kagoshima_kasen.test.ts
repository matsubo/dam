// apps/worker/src/tasks/ingest_kagoshima_kasen.test.ts
//
// Fixture is a verbatim Shift_JIS capture of 鹿児島県河川砂防情報システム
// servletBousaiTableStatus?dk=4 (ダム一覧表, 全県) taken 2026-09-27 16:40 JST.
// Columns: 局名 | 所在地 | 最新観測時刻 | 貯水位[EL.m] | 貯水量[10³m³] |
// 全流入量[m³/s] | 全放流量[m³/s] | 空容量[10³m³] | 貯水率（治水）[%] |
// 貯水率（利水）[%].

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseKagoshimaKasenTable } from './ingest_kagoshima_kasen.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kagoshima_kasen/dam_table_2026-09-27.shiftjis.html',
);

async function fixtureHtml(): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
}

describe('parseKagoshimaKasenTable', () => {
  test('lists every dam the 一覧表 publishes', async () => {
    const rows = parseKagoshimaKasenTable(await fixtureHtml());
    expect(rows.map((r) => r.name)).toEqual(['大和ダム', '西之谷ダム', '川辺ダム']);
  });

  test('reads 川辺 level, 千m³ volume, flows and JST time', async () => {
    const kawanabe = parseKagoshimaKasenTable(await fixtureHtml()).find(
      (r) => r.name === '川辺ダム',
    );
    expect(kawanabe?.observedAt?.toISOString()).toBe('2026-09-27T07:30:00.000Z');
    expect(kawanabe?.waterLevelM).toBe(149.86);
    expect(kawanabe?.storageVolumeM3).toBe(645_000);
    expect(kawanabe?.inflowM3s).toBe(0.977);
    expect(kawanabe?.outflowM3s).toBe(0.981);
    expect(kawanabe?.storageRate).toBeCloseTo(0.977, 6);
  });

  test('takes 貯水率（利水） over 貯水率（治水） when both are published', async () => {
    // 大和: 治水 29.2 % is 210 / 有効 721 千m³; 利水 100.0 % is the 利水 pool.
    const yamato = parseKagoshimaKasenTable(await fixtureHtml()).find((r) => r.name === '大和ダム');
    expect(yamato?.storageVolumeM3).toBe(210_000);
    expect(yamato?.storageRate).toBe(1);
  });

  test('leaves the rate empty for a flood-control dam that publishes only 治水', async () => {
    // 西之谷 is 治水専用: 利水 is blank and the 0.8 % 治水 figure divides by
    // 有効貯水容量, which is not the 利水 basis this source is trusted for.
    const nishinotani = parseKagoshimaKasenTable(await fixtureHtml()).find(
      (r) => r.name === '西之谷ダム',
    );
    expect(nishinotani?.storageVolumeM3).toBe(6_000);
    expect(nishinotani?.storageRate).toBeNull();
  });

  test('maps 欠測 / 範囲異常 / 無効 markers to null and keeps a station with no time', async () => {
    const html = (await fixtureHtml())
      .replace(
        '2026/09/27&nbsp;16:30</td><td align="center" class=" ">',
        '</td><td align="center" class=" ">',
      )
      .replace('&rarr;&nbsp;&nbsp;149.86', '###')
      .replace('&rarr;&nbsp;&nbsp;&nbsp;&nbsp;645', '***')
      .replace('&rarr;&nbsp;&nbsp;97.7', '---');
    const rows = parseKagoshimaKasenTable(html);
    const nishinotani = rows.find((r) => r.name === '西之谷ダム');
    expect(nishinotani?.observedAt).toBeNull();
    const kawanabe = rows.find((r) => r.name === '川辺ダム');
    expect(kawanabe?.waterLevelM).toBeNull();
    expect(kawanabe?.storageVolumeM3).toBeNull();
    expect(kawanabe?.storageRate).toBeNull();
    expect(kawanabe?.inflowM3s).toBe(0.977);
  });
});

describe('chooseMaster', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp });

  test('binds each station to its master by stem', () => {
    const masters = [m(11425, '大和'), m(11446, '川辺'), m(11454, '西之谷')];
    expect(chooseMaster('川辺ダム', masters)).toBe(11446n);
    expect(chooseMaster('西之谷ダム', masters)).toBe(11454n);
  });

  test('keeps the row already stamped with the station over a lower-id name hit', () => {
    const masters = [m(10, '大和'), m(20, '大和', null, '大和ダム')];
    expect(chooseMaster('大和ダム', masters)).toBe(20n);
  });

  test('binds a redeveloped dam to the completed （再）, not the lower-id （元）', () => {
    const masters = [m(10, '川辺（元）', 1960), m(20, '川辺（再）', 2002)];
    expect(chooseMaster('川辺ダム', masters)).toBe(20n);
  });
});
