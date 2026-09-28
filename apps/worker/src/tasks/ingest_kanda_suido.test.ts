// apps/worker/src/tasks/ingest_kanda_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 苅田町水道課「水道の安定供給と安全性」
// (town.kanda.lg.jp/page/2021.html) taken 2026-09-28 15:55 JST, showing the
// 「令和 8年 9月 28日現在」 水源の状況 table (更新日 2026年9月28日).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  type KandaMaster,
  parseKandaSuigen,
  planKanda,
} from './ingest_kanda_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kanda_suido/2021_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

const MASTERS: KandaMaster[] = [
  { id: 10997n, name: '山口', ndi: '2248', completedYear: 1996, stamp: null },
  { id: 11058n, name: '山口調整池', ndi: '2487', completedYear: 1998, stamp: null },
  { id: 10999n, name: '油木', ndi: '2253', completedYear: 1971, stamp: null },
];

describe('parseKandaSuigen', () => {
  test('lists the three reservoirs of 表1 and nothing from 表2', () => {
    expect(parseKandaSuigen(html).rows.map((r) => r.name)).toEqual([
      '油木ダム',
      '山口ダム',
      '井ノ口池',
    ]);
  });

  test('reads the spaced 「令和 8年 9月 28日現在」 as 00:00 JST', () => {
    expect(parseKandaSuigen(html).observedAt?.toISOString()).toBe('2026-09-27T15:00:00.000Z');
  });

  test('reads 千立方メートル as m³ and the rate as a fraction', () => {
    const yamaguchi = parseKandaSuigen(html).rows.find((r) => r.name === '山口ダム');
    expect(yamaguchi?.capacityM3).toBe(736_000);
    expect(yamaguchi?.storageVolumeM3).toBe(633_000);
    expect(yamaguchi?.storageRate).toBeCloseTo(0.859, 6);
  });

  test('ignores the 前年同日貯水量 column', () => {
    expect(parseKandaSuigen(html).rows.find((r) => r.name === '油木ダム')?.storageVolumeM3).toBe(
      6_463_000,
    );
  });

  test('no 現在 line → null date', () => {
    expect(parseKandaSuigen(html.replace('日現在', '日')).observedAt).toBeNull();
  });
});

describe('chooseMaster', () => {
  test('山口ダム is 福岡県の山口 (NDI 2248), not 山口調整池', () => {
    expect(chooseMaster('山口ダム', MASTERS)).toBe(10997n);
  });

  test('油木ダム binds by name', () => {
    expect(chooseMaster('油木ダム', MASTERS)).toBe(10999n);
  });

  test('井ノ口池 is not in the master', () => {
    expect(chooseMaster('井ノ口池', MASTERS)).toBeNull();
  });
});

describe('planKanda', () => {
  test('records all three and writes 油木 and 山口', () => {
    const { universe, writes } = planKanda(parseKandaSuigen(html).rows, MASTERS);
    expect(universe.map((u) => [u.externalId, u.resolvedDamId])).toEqual([
      ['油木ダム', 10999n],
      ['山口ダム', 10997n],
      ['井ノ口池', null],
    ]);
    expect(writes.map((w) => [w.damId, w.row.storageVolumeM3])).toEqual([
      [10999n, 6_463_000],
      [10997n, 633_000],
    ]);
    expect(writes[0]?.row.storageRate).toBeCloseTo(0.447, 6);
  });
});
