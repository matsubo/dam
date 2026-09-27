// Fixture: tests/fixtures/yamanashi/dam005_2026-09-27.shiftjis.html — the
// ダム状況表 (dam005.asp) as served on 2026-09-27 16:00 JST, raw Shift_JIS
// bytes. Columns: ダム名 / 貯水位[EL.m] / 貯水量[千 m3] / 空容量[千 m3] /
// 全流入量[m3/s] / 全放流量[m3/s] / ダム雨量 時間[mm/h] / 累計[mm].

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  parseYamanashiStatusHtml,
  parseYamanashiTimestamp,
} from './ingest_yamanashi_dam.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/yamanashi/dam005_2026-09-27.shiftjis.html',
);

async function fixtureHtml(): Promise<string> {
  return new TextDecoder('shift_jis').decode(await readFile(FIXTURE));
}

describe('parseYamanashiTimestamp', () => {
  test('parses the "現在" header (JST) → UTC', () => {
    const d = parseYamanashiTimestamp('2026年09月27日 16時00分 現在');
    expect(d?.toISOString()).toBe('2026-09-27T07:00:00.000Z');
  });

  test('treats "24時00分" as next-day 00:00 JST', () => {
    const d = parseYamanashiTimestamp('2026年09月26日 24時00分 現在');
    expect(d?.toISOString()).toBe('2026-09-26T15:00:00.000Z');
  });

  test('returns null when there is no timestamp', () => {
    expect(parseYamanashiTimestamp('')).toBeNull();
    expect(parseYamanashiTimestamp('2026/09/27 16:00')).toBeNull();
  });
});

describe('parseYamanashiStatusHtml', () => {
  test('reads all six dams at the page timestamp', async () => {
    const rows = parseYamanashiStatusHtml(await fixtureHtml());
    expect(rows.map((r) => r.yamanashiName)).toEqual([
      '大門ダム',
      '塩川ダム',
      '広瀬ダム',
      '琴川ダム',
      '荒川ダム',
      '深城ダム',
    ]);
    for (const r of rows) expect(r.observedAt.toISOString()).toBe('2026-09-27T07:00:00.000Z');
  });

  test('takes 貯水量 (not 空容量) and converts 千m³ → m³', async () => {
    const rows = parseYamanashiStatusHtml(await fixtureHtml());
    const daimon = rows.find((r) => r.yamanashiName === '大門ダム');
    expect(daimon).toEqual({
      yamanashiName: '大門ダム',
      observedAt: new Date('2026-09-27T07:00:00.000Z'),
      waterLevelM: 895.49,
      storageVolumeM3: 1_114_000,
      inflowM3s: 2.31,
      outflowM3s: 3.69,
      rainfallMm: 0,
    });
    // 深城: 貯水量 880 / 空容量 4,457 千m³.
    expect(rows.find((r) => r.yamanashiName === '深城ダム')?.storageVolumeM3).toBe(880_000);
  });

  test('a blank cell is missing, not zero', async () => {
    const html = (await fixtureHtml()).replace('<TD>1114</TD>', '<TD>&nbsp;</TD>');
    const daimon = parseYamanashiStatusHtml(html).find((r) => r.yamanashiName === '大門ダム');
    expect(daimon?.storageVolumeM3).toBeNull();
    expect(daimon?.waterLevelM).toBe(895.49);
  });

  test('refuses a 貯水量 column no longer labelled 千 m3', async () => {
    const html = (await fixtureHtml()).replace('貯水量<BR>[千 m3]', '貯水量<BR>[万 m3]');
    expect(() => parseYamanashiStatusHtml(html)).toThrow();
  });

  test('returns no rows when the page has no timestamp', () => {
    expect(parseYamanashiStatusHtml('<html><body><table></table></body></html>')).toEqual([]);
  });
});

describe('chooseMaster (#79)', () => {
  const m = (
    id: number,
    name: string,
    completedYear: number | null = null,
    stamp: string | null = null,
  ) => ({
    id: BigInt(id),
    name,
    completedYear,
    stamp,
  });

  test('keeps the row already stamped with the station code over a better name match', () => {
    const masters = [m(10, '大門ダム'), m(20, '大門', null, '5002')];
    expect(chooseMaster('大門ダム', masters, '5002')).toBe(20n);
  });

  test('ignores a stamp for another station and ranks by name', () => {
    const masters = [m(10, '大門ダム'), m(20, '大門', null, '5001')];
    expect(chooseMaster('大門ダム', masters, '5002')).toBe(10n);
  });

  test('binds to the completed （再）, not the lower-id （元）', () => {
    const masters = [m(10, '荒川（元）', 1960), m(20, '荒川（再）', 2010)];
    expect(chooseMaster('荒川ダム', masters, '1001')).toBe(20n);
  });
});
