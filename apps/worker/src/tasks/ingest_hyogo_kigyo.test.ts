// apps/worker/src/tasks/ingest_hyogo_kigyo.test.ts
//
// Fixture is a verbatim UTF-8 capture of 兵庫県企業庁「貯水状況」
// (web.pref.hyogo.lg.jp/kc02/ea02_000000005.html) taken 2026-09-28: the
// 「2026年9月24日現在」 table of the 10 水源 of 県営水道 / 県営工業用水道.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hyogoKigyoEntries, parseHyogoKigyoChosui } from './ingest_hyogo_kigyo.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/hyogo_kigyo/chosui_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');
const parsed = parseHyogoKigyoChosui(html);

describe('parseHyogoKigyoChosui', () => {
  test('dates the table from its 「…現在」 line, at 00:00 JST', () => {
    expect(parsed.observedAt?.toISOString()).toBe('2026-09-23T15:00:00.000Z');
  });

  test('reads every 水源 row, without the 洪水期制限水量 table below it', () => {
    expect(parsed.rows.map((r) => r.name)).toEqual([
      '一庫ダム',
      '青野ダム',
      '呑吐ダム',
      '大川瀬ダム',
      '平荘ダム',
      '権現ダム',
      '生野ダム',
      '黒川ダム',
      '引原ダム',
      '神谷ダム',
    ]);
  });

  test('converts 千m³ to m³ and % to a fraction', () => {
    const kamitani = parsed.rows.find((r) => r.name === '神谷ダム');
    expect(kamitani?.storageVolumeM3).toBe(13_989_000);
    expect(kamitani?.storageRate).toBeCloseTo(0.869, 6);
  });

  test('reads a rate in a cell styled differently from its row', () => {
    // 一庫's 貯水率 <td> carries style="text-align: center;" and a bare <p>.
    expect(parsed.rows.find((r) => r.name === '一庫ダム')?.storageRate).toBe(1);
  });

  test('keeps a row whose readings are blank as published, with nulls', () => {
    const blank = html.replace(
      /(<p align="center">13,989<\/p>\s*<\/td>\s*<td>\s*<p align="center">)86\.9/,
      '$1－',
    );
    const kamitani = parseHyogoKigyoChosui(blank).rows.find((r) => r.name === '神谷ダム');
    expect(kamitani?.storageVolumeM3).toBe(13_989_000);
    expect(kamitani?.storageRate).toBeNull();
  });

  test('finds no date and no rows on an unrelated page', () => {
    expect(parseHyogoKigyoChosui('<html><body><table></table></body></html>')).toEqual({
      observedAt: null,
      rows: [],
    });
  });
});

describe('hyogoKigyoEntries', () => {
  const entries = (rows = parsed.rows) => {
    if (!parsed.observedAt) throw new Error('no date');
    return hyogoKigyoEntries(parsed.observedAt, rows);
  };

  test('lists every 水源; writes 神谷 only, 黒川 (the 企業庁 share) never binds', () => {
    const list = entries();
    expect(list).toHaveLength(10);
    expect(list.filter((e) => !e.dontWrite).map((e) => e.key)).toEqual(['黒川ダム', '神谷ダム']);
    expect(list.find((e) => e.key === '黒川ダム')?.bind).toBe('never');
    expect(list.every((e) => e.pref === '28')).toBe(true);
  });

  test('神谷 reads its volume and rate at the 現在 date', () => {
    const r = entries().find((e) => e.key === '神谷ダム')?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-09-23T15:00:00.000Z');
    expect(r.observations[0]?.storageVolumeM3).toBe(13_989_000);
    expect(r.observations[0]?.storageRate).toBeCloseTo(0.869, 6);
  });

  test('神谷 with both readings blank is unreadable', () => {
    const rows = parsed.rows.map((r) =>
      r.name === '神谷ダム' ? { ...r, storageVolumeM3: null, storageRate: null } : r,
    );
    expect(entries(rows).find((e) => e.key === '神谷ダム')?.reading).toMatchObject({
      state: 'unreadable',
    });
  });
});
