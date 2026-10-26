// apps/worker/src/tasks/ingest_kagoshima_kasen.test.ts
//
// Fixture is a verbatim Shift_JIS capture of 鹿児島県河川砂防情報システム
// servletBousaiTableStatus?dk=4 (ダム一覧表, 全県) taken 2026-09-27 16:40 JST.
// Columns: 局名 | 所在地 | 最新観測時刻 | 貯水位[EL.m] | 貯水量[10³m³] |
// 全流入量[m³/s] | 全放流量[m³/s] | 空容量[10³m³] | 貯水率（治水）[%] |
// 貯水率（利水）[%].
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Reading } from '../ingest/types.ts';
import { kagoshimaKasenEntries } from './ingest_kagoshima_kasen.ts';

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

function observation(e: Entry | undefined) {
  const r = e?.reading as Reading | undefined;
  if (r?.state !== 'values') throw new Error('no values');
  const o = r.observations[0];
  if (!o) throw new Error('no observation');
  return o;
}

async function dam(name: string, html?: string) {
  return kagoshimaKasenEntries(html ?? (await fixtureHtml())).find((e) => e.name === name);
}

describe('kagoshimaKasenEntries', () => {
  test('lists every dam the 一覧表 publishes, keyed by 局名', async () => {
    const list = kagoshimaKasenEntries(await fixtureHtml());
    expect(list.map((e) => e.key)).toEqual(['大和ダム', '西之谷ダム', '川辺ダム']);
    expect(list.every((e) => e.name === e.key && e.pref === '46')).toBe(true);
  });

  test('reads 川辺 level, 千m³ volume, flows and JST time', async () => {
    const kawanabe = observation(await dam('川辺ダム'));
    expect(kawanabe.observedAt.toISOString()).toBe('2026-09-27T07:30:00.000Z');
    expect(kawanabe.waterLevelM).toBe(149.86);
    expect(kawanabe.storageVolumeM3).toBe(645_000);
    expect(kawanabe.inflowM3s).toBe(0.977);
    expect(kawanabe.outflowM3s).toBe(0.981);
    expect(kawanabe.storageRate).toBeCloseTo(0.977, 6);
  });

  test('takes 貯水率（利水） over 貯水率（治水） when both are published', async () => {
    // 大和: 治水 29.2 % is 210 / 有効 721 千m³; 利水 100.0 % is the 利水 pool.
    const yamato = observation(await dam('大和ダム'));
    expect(yamato.storageVolumeM3).toBe(210_000);
    expect(yamato.storageRate).toBe(1);
  });

  test('leaves the rate empty for a flood-control dam that publishes only 治水', async () => {
    // 西之谷 is 治水専用: 利水 is blank and the 0.8 % 治水 figure divides by
    // 有効貯水容量, which is not the 利水 basis this source is trusted for.
    const nishinotani = observation(await dam('西之谷ダム'));
    expect(nishinotani.storageVolumeM3).toBe(6_000);
    expect(nishinotani.storageRate).toBeNull();
  });

  test('maps 欠測 / 範囲異常 / 無効 markers to null; a station with no time is unreadable', async () => {
    const html = (await fixtureHtml())
      .replace(
        '2026/09/27&nbsp;16:30</td><td align="center" class=" ">',
        '</td><td align="center" class=" ">',
      )
      .replace('&rarr;&nbsp;&nbsp;149.86', '###')
      .replace('&rarr;&nbsp;&nbsp;&nbsp;&nbsp;645', '***')
      .replace('&rarr;&nbsp;&nbsp;97.7', '---');
    expect((await dam('西之谷ダム', html))?.reading).toEqual({
      state: 'unreadable',
      why: 'no 最新観測時刻',
    });
    const kawanabe = observation(await dam('川辺ダム', html));
    expect(kawanabe.waterLevelM).toBeNull();
    expect(kawanabe.storageVolumeM3).toBeNull();
    expect(kawanabe.storageRate).toBeNull();
    expect(kawanabe.inflowM3s).toBe(0.977);
  });

  test('a dam marked in every column it is read for is provider-marked empty', () => {
    const td = (s: string) => `<td>${s}</td>`;
    const html = `<tr>${td('<a href="#">川辺ダム</a>')}${td('南九州市')}${td('2026/09/27&nbsp;16:30')}${td('***')}${td('***')}${td('---')}${td('###')}${td('')}${td('')}${td('')}</tr>`;
    expect((kagoshimaKasenEntries(html)[0]?.reading as Reading | undefined)?.state).toBe('empty');
  });
});
