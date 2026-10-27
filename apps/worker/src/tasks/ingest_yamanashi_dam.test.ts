// Fixture: tests/fixtures/yamanashi/dam005_2026-09-27.shiftjis.html — the
// ダム状況表 (dam005.asp) as served on 2026-09-27 16:00 JST, raw Shift_JIS
// bytes. Columns: ダム名 / 貯水位[EL.m] / 貯水量[千 m3] / 空容量[千 m3] /
// 全流入量[m3/s] / 全放流量[m3/s] / ダム雨量 時間[mm/h] / 累計[mm].

// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  parseYamanashiStatusHtml,
  parseYamanashiTimestamp,
  yamanashiEntries,
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

function observed(entries: Entry[], key: string): Observed {
  const r = entries.find((e) => e.key === key)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') throw new Error(`${key}: no values`);
  const [o] = r.observations;
  if (!o) throw new Error(`${key}: no observation`);
  return o;
}

describe('yamanashiEntries', () => {
  const warn = (): void => {};

  test('reads all six dams, keyed by station code, at the page timestamp', async () => {
    const entries = yamanashiEntries(await fixtureHtml(), warn);
    expect(entries.map((e) => [e.key, e.name])).toEqual([
      ['5002', '大門ダム'],
      ['5001', '塩川ダム'],
      ['4001', '広瀬ダム'],
      ['4002', '琴川ダム'],
      ['1001', '荒川ダム'],
      ['8001', '深城ダム'],
    ]);
    for (const e of entries) {
      expect(e.pref).toBe('19');
      expect(observed(entries, e.key).observedAt.toISOString()).toBe('2026-09-27T07:00:00.000Z');
    }
  });

  test('takes 貯水量 (not 空容量) and converts 千m³ → m³', async () => {
    const entries = yamanashiEntries(await fixtureHtml(), warn);
    expect(observed(entries, '5002')).toEqual({
      observedAt: new Date('2026-09-27T07:00:00.000Z'),
      waterLevelM: 895.49,
      storageVolumeM3: 1_114_000,
      inflowM3s: 2.31,
      outflowM3s: 3.69,
      rainfallMm: 0,
    });
    // 深城: 貯水量 880 / 空容量 4,457 千m³.
    expect(observed(entries, '8001').storageVolumeM3).toBe(880_000);
  });

  test('a blank cell is missing, not zero', async () => {
    const html = (await fixtureHtml()).replace('<TD>1114</TD>', '<TD>&nbsp;</TD>');
    const daimon = observed(yamanashiEntries(html, warn), '5002');
    expect(daimon.storageVolumeM3).toBeNull();
    expect(daimon.waterLevelM).toBe(895.49);
  });

  test('drops only the volumes when 貯水量 is no longer labelled 千 m3', async () => {
    const html = (await fixtureHtml()).replace('貯水量<BR>[千 m3]', '貯水量<BR>[万 m3]');
    const warnings: string[] = [];
    const entries = yamanashiEntries(html, (s) => warnings.push(s));
    expect(entries).toHaveLength(6);
    for (const e of entries) expect(observed(entries, e.key).storageVolumeM3).toBeNull();
    expect(observed(entries, '5002')).toMatchObject({
      waterLevelM: 895.49,
      inflowM3s: 2.31,
      outflowM3s: 3.69,
      rainfallMm: 0,
    });
    expect(warnings).toHaveLength(1);
  });

  test('a dam missing from the page is unreadable; a row outside the catalogue is listed by name', async () => {
    const html = (await fixtureHtml()).replace('>深城ダム<', '>新設ダム<');
    const entries = yamanashiEntries(html, warn);
    expect(entries.find((e) => e.key === '8001')?.reading).toEqual({
      state: 'unreadable',
      why: 'not on the page',
    });
    const extra = entries.find((e) => e.key === '新設ダム');
    expect(extra?.name).toBe('新設ダム');
    expect(observed(entries, '新設ダム').storageVolumeM3).toBe(880_000);
  });

  test('every catalogue dam is unreadable when the page has no timestamp', () => {
    expect(parseYamanashiStatusHtml('<html><body><table></table></body></html>', warn)).toBeNull();
    const entries = yamanashiEntries('<html><body><table></table></body></html>', warn);
    expect(entries).toHaveLength(6);
    for (const e of entries) {
      expect(e.reading).toEqual({ state: 'unreadable', why: 'no 現在 timestamp' });
    }
  });
});
