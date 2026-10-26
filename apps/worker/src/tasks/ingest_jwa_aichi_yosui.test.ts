// apps/worker/src/tasks/ingest_jwa_aichi_yosui.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim UTF-8 capture of 水資源機構 愛知用水総合管理所 水情報
// (water.go.jp/chubu/aityosui/b(jyouhou-main)/02(mizu)/00(top)/b-02.html)
// taken 2026-09-27 21:40 JST, reporting "2026年9月27日（日）0時現在":
//   牧尾ダム   水位(標高) 877.13 m, 貯水量 59,343 千m³, 貯水率 87.3 %,
//              流入量 14.73 m³/s, 放流量 6.42 m³/s (previous-day daily means)
//   東郷調整池 貯水位 68.34 m, 貯水量 7,642 千m³, 貯水率 84.9 %
//   前山池     貯水位 20.19 m, 貯水量   316 千m³, 貯水率 32.5 %

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import { aichiYosuiEntries } from './ingest_jwa_aichi_yosui.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/jwa_aichi_yosui/mizu_2026-09-27.html',
);

async function fixtureHtml(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

function entry(list: Entry[], key: string): Entry {
  const e = list.find((x) => x.key === key);
  if (!e) throw new Error(`no entry ${key}`);
  return e;
}

function observed(e: Entry): Observed {
  const r = e.reading;
  if (typeof r === 'function' || r.state !== 'values') throw new Error(`${e.key}: no values`);
  expect(r.observations).toHaveLength(1);
  const o = r.observations[0];
  if (!o) throw new Error(`${e.key}: no observation`);
  return o;
}

describe('aichiYosuiEntries', () => {
  test('lists the three facilities at the page 0時 JST time', async () => {
    const list = aichiYosuiEntries({ html: await fixtureHtml() });
    expect(list.map((e) => [e.key, e.name, e.pref])).toEqual([
      ['牧尾ダム', '牧尾ダム', '20'],
      ['東郷調整池', '東郷調整池', '23'],
      ['前山池', '前山池', '23'],
    ]);
    for (const e of list) {
      expect(observed(e).observedAt.toISOString()).toBe('2026-09-26T15:00:00.000Z');
    }
  });

  test('前山池 binds by the master name 前山 (ダム便覧 lists the pond as 前山)', async () => {
    const list = aichiYosuiEntries({ html: await fixtureHtml() });
    expect(entry(list, '前山池').bind).toEqual({ name: '前山' });
    expect(entry(list, '牧尾ダム').bind).toBeUndefined();
    expect(entry(list, '東郷調整池').bind).toBeUndefined();
  });

  test('reads 東郷調整池 level, 千m³ volume as m³ and % rate as a fraction', async () => {
    const togo = observed(entry(aichiYosuiEntries({ html: await fixtureHtml() }), '東郷調整池'));
    expect(togo.waterLevelM).toBe(68.34);
    expect(togo.storageVolumeM3).toBe(7_642_000);
    expect(togo.storageRate).toBeCloseTo(0.849, 6);
  });

  test('reads 前山池 from the second column of the 調整池 table', async () => {
    const maeyama = observed(entry(aichiYosuiEntries({ html: await fixtureHtml() }), '前山池'));
    expect(maeyama.waterLevelM).toBe(20.19);
    expect(maeyama.storageVolumeM3).toBe(316_000);
    expect(maeyama.storageRate).toBeCloseTo(0.325, 6);
  });

  test('reads 牧尾ダム 0時 level, volume and rate but not the previous-day mean flows', async () => {
    const makio = observed(entry(aichiYosuiEntries({ html: await fixtureHtml() }), '牧尾ダム'));
    expect(makio).toEqual({
      observedAt: new Date('2026-09-26T15:00:00.000Z'),
      waterLevelM: 877.13,
      storageVolumeM3: 59_343_000,
      storageRate: 0.873,
    });
  });

  test('maps a non-numeric cell to null and keeps the other column', async () => {
    const html = (await fixtureHtml()).replace('>7,642<', '>欠測<');
    const list = aichiYosuiEntries({ html });
    const togo = observed(entry(list, '東郷調整池'));
    expect(togo.storageVolumeM3).toBeNull();
    expect(togo.waterLevelM).toBe(68.34);
    expect(observed(entry(list, '前山池')).storageVolumeM3).toBe(316_000);
  });

  test('a station whose every cell reads 欠測 is provider-marked empty', async () => {
    const html = (await fixtureHtml())
      .replace('>877.13<', '>欠測<')
      .replace('>59,343<', '>欠測<')
      .replace(/>87\.3</, '>欠測<');
    expect(entry(aichiYosuiEntries({ html }), '牧尾ダム').reading).toEqual({
      state: 'empty',
      mark: '欠測 in every column',
    });
  });

  test('a page without the report header leaves every station unreadable', () => {
    const list = aichiYosuiEntries({ html: '<html><body>メンテナンス中</body></html>' });
    expect(list).toHaveLength(3);
    for (const e of list) expect(e.reading).toMatchObject({ state: 'unreadable' });
  });

  test('a failed fetch still lists every station, unreadable', () => {
    const list = aichiYosuiEntries({ failed: 'HTTP 503' });
    expect(list.map((e) => e.reading)).toEqual([
      { state: 'unreadable', why: 'HTTP 503' },
      { state: 'unreadable', why: 'HTTP 503' },
      { state: 'unreadable', why: 'HTTP 503' },
    ]);
  });
});
