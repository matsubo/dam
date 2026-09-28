// apps/worker/src/tasks/ingest_hyogo_kigyo.test.ts
//
// Fixture is a verbatim UTF-8 capture of 兵庫県企業庁「貯水状況」
// (web.pref.hyogo.lg.jp/kc02/ea02_000000005.html) taken 2026-09-28: the
// 「2026年9月24日現在」 table of the 10 水源 of 県営水道 / 県営工業用水道.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindableMaster } from '@dam/core/dam_binding';
import { chooseMaster, parseHyogoKigyoChosui, storedReadings } from './ingest_hyogo_kigyo.ts';

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

describe('storedReadings', () => {
  test('writes 神谷 only: 黒川 is the 企業庁 share, the rest are other bases or totals', () => {
    expect(storedReadings(parsed.rows).map((r) => r.name)).toEqual(['神谷ダム']);
  });

  test('drops 神谷 when both of its readings are blank', () => {
    const rows = parsed.rows.map((r) =>
      r.name === '神谷ダム' ? { ...r, storageVolumeM3: null, storageRate: null } : r,
    );
    expect(storedReadings(rows)).toEqual([]);
  });
});

describe('chooseMaster', () => {
  // Real prod rows (兵庫 28) whose names share a stem with a published row.
  const masters: BindableMaster[] = [
    { id: 10194n, name: '一庫', completedYear: 1983 },
    { id: 10195n, name: '青野', completedYear: 1987 },
    { id: 10210n, name: '平荘第1', completedYear: 1969 },
    { id: 10211n, name: '平荘第2', completedYear: 1969 },
    { id: 10212n, name: '平荘第3', completedYear: 1969 },
    { id: 10221n, name: '大川瀬', completedYear: 1991 },
    { id: 10229n, name: '呑吐', completedYear: 1987 },
    { id: 10230n, name: '権現第1', completedYear: 1981 },
    { id: 10231n, name: '権現第3', completedYear: 1981 },
    { id: 10234n, name: '黒川', completedYear: 1974 },
    { id: 10235n, name: '生野', completedYear: 1972 },
    { id: 10242n, name: '神谷', completedYear: 2000 },
    { id: 10244n, name: '引原', completedYear: 1957 },
  ];

  test('binds a single dam by its name without ダム', () => {
    expect(chooseMaster('神谷ダム', masters)).toBe(10242n);
    expect(chooseMaster('青野ダム', masters)).toBe(10195n);
    expect(chooseMaster('呑吐ダム', masters)).toBe(10229n);
  });

  test('leaves a reservoir total over several dam bodies unresolved', () => {
    expect(chooseMaster('平荘ダム', masters)).toBeNull();
    expect(chooseMaster('権現ダム', masters)).toBeNull();
  });

  test('leaves 黒川 unresolved: its figures are the 企業庁 share, not the dam', () => {
    expect(chooseMaster('黒川ダム', masters)).toBeNull();
    // A stamp from an earlier run must not re-bind it either.
    const stamped = masters.map((m) => (m.id === 10234n ? { ...m, stamp: '黒川ダム' } : m));
    expect(chooseMaster('黒川ダム', stamped)).toBeNull();
  });
});
