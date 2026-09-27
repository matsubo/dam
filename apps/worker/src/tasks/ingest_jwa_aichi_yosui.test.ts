// apps/worker/src/tasks/ingest_jwa_aichi_yosui.test.ts
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
import { parseAichiYosuiPage } from './ingest_jwa_aichi_yosui.ts';

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

describe('parseAichiYosuiPage', () => {
  test('lists the three facilities at the page 0時 JST time', async () => {
    const { observedAt, rows } = parseAichiYosuiPage(await fixtureHtml());
    expect(observedAt?.toISOString()).toBe('2026-09-26T15:00:00.000Z');
    expect(rows.map((r) => r.name)).toEqual(['牧尾ダム', '東郷調整池', '前山池']);
  });

  test('reads 東郷調整池 level, 千m³ volume as m³ and % rate as a fraction', async () => {
    const togo = parseAichiYosuiPage(await fixtureHtml()).rows.find((r) => r.name === '東郷調整池');
    expect(togo?.waterLevelM).toBe(68.34);
    expect(togo?.storageVolumeM3).toBe(7_642_000);
    expect(togo?.storageRate).toBeCloseTo(0.849, 6);
  });

  test('reads 前山池 from the second column of the 調整池 table', async () => {
    const maeyama = parseAichiYosuiPage(await fixtureHtml()).rows.find((r) => r.name === '前山池');
    expect(maeyama?.waterLevelM).toBe(20.19);
    expect(maeyama?.storageVolumeM3).toBe(316_000);
    expect(maeyama?.storageRate).toBeCloseTo(0.325, 6);
  });

  test('reads 牧尾ダム 0時 level, volume and rate but not the previous-day mean flows', async () => {
    const makio = parseAichiYosuiPage(await fixtureHtml()).rows.find((r) => r.name === '牧尾ダム');
    expect(makio).toEqual({
      name: '牧尾ダム',
      waterLevelM: 877.13,
      storageVolumeM3: 59_343_000,
      storageRate: 0.873,
    });
  });

  test('maps a non-numeric cell to null and keeps the other column', async () => {
    const html = (await fixtureHtml()).replace('>7,642<', '>欠測<');
    const { rows } = parseAichiYosuiPage(html);
    expect(rows.find((r) => r.name === '東郷調整池')?.storageVolumeM3).toBeNull();
    expect(rows.find((r) => r.name === '東郷調整池')?.waterLevelM).toBe(68.34);
    expect(rows.find((r) => r.name === '前山池')?.storageVolumeM3).toBe(316_000);
  });

  test('returns no time and no rows for a page without the report header', () => {
    expect(parseAichiYosuiPage('<html><body>メンテナンス中</body></html>')).toEqual({
      observedAt: null,
      rows: [],
    });
  });
});
