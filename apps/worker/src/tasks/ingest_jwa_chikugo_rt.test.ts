// apps/worker/src/tasks/ingest_jwa_chikugo_rt.test.ts
//
// Fixtures are verbatim Shift_JIS captures of 水資源機構 筑後川局
// 水管理情報WEB (chikugo.ec-net.jp/chikugo/kyoku/pc/new/rep{EG,KB,CO}_I60.html)
// taken 2026-09-27 21:43 JST: 24 hourly rows, 2026/09/26 22:00 … 09/27 21:00.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseChikugoRtPage, STATIONS } from './ingest_jwa_chikugo_rt.ts';

async function page(code: string): Promise<string> {
  const path = join(
    import.meta.dir,
    '..',
    '..',
    '..',
    '..',
    `tests/fixtures/jwa_chikugo_rt/rep${code}_I60_2026-09-27.shiftjis.html`,
  );
  return new TextDecoder('shift_jis').decode(await readFile(path));
}

describe('parseChikugoRtPage', () => {
  test('reads every hourly row of 小石原川ダム in JST, oldest first', async () => {
    const rows = parseChikugoRtPage(await page('KB'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-26T13:00:00Z'), // 09/26 22:00 JST
      waterLevelM: 321.72,
      storageVolumeM3: 12_617_000,
      storageRate: 0.36,
      inflowM3s: 2.29,
      // 総放流量, not the 利水ゲート放流量 (0.00) printed two columns earlier.
      outflowM3s: 0.45,
      rainfallMm: 0,
    });
    expect(rows[23]?.observedAt).toEqual(new Date('2026-09-27T12:00:00Z'));
    expect(rows[23]?.storageVolumeM3).toBe(12_874_000);
  });

  test('reads "24:00" under the previous date as midnight of the next day', async () => {
    const rows = parseChikugoRtPage(await page('KB'));
    expect(rows[2]?.observedAt).toEqual(new Date('2026-09-26T15:00:00Z')); // 09/27 00:00 JST
    expect(rows[2]?.waterLevelM).toBe(321.75);
    expect(rows[3]?.observedAt).toEqual(new Date('2026-09-26T16:00:00Z')); // 09/27 01:00 JST
    const times = rows.map((r) => r.observedAt.getTime());
    expect(new Set(times).size).toBe(24);
  });

  test('maps the 欠測 marker to null without dropping the row', async () => {
    const rows = parseChikugoRtPage(await page('EG'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({
      waterLevelM: 188.21,
      storageVolumeM3: 3_011_000,
      storageRate: 0.125,
      outflowM3s: 0.23,
      rainfallMm: null, // ***
    });
  });

  test('reads 筑後大堰 pool level and volume, not its 設定水位, and no flows', async () => {
    const rows = parseChikugoRtPage(await page('CO'));
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-09-26T13:00:00Z'),
      waterLevelM: 3.41,
      storageVolumeM3: 930_000,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
      rainfallMm: 0,
    });
  });
});

describe('chooseMaster', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({ id: BigInt(id), name, completedYear, stamp });
  const station = (code: string) => {
    const s = STATIONS.find((x) => x.code === code);
    if (!s) throw new Error(code);
    return s;
  };

  test('binds each station to the master of the same name', () => {
    const masters = [m(11054, '寺内', 1978), m(11055, '江川', 1972), m(11080, '筑後大堰', 1984)];
    expect(chooseMaster(station('EG'), masters)).toBe(11055n);
    expect(chooseMaster(station('TR'), masters)).toBe(11054n);
    expect(chooseMaster(station('CO'), masters)).toBe(11080n);
  });

  test('does not bind a dam whose name merely contains the station name', () => {
    expect(chooseMaster(station('OY'), [m(1, '大山川')])).toBeNull();
  });

  test('keeps the row already stamped with the station code', () => {
    const masters = [m(1, '江川'), m(2, '江川', null, 'EG')];
    expect(chooseMaster(station('EG'), masters)).toBe(2n);
  });

  test('binds the completed （再） over the lower-id （元）', () => {
    const masters = [m(1, '寺内（元）', 1978), m(2, '寺内（再）', 2020)];
    expect(chooseMaster(station('TR'), masters)).toBe(2n);
  });
});
