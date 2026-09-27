// apps/worker/src/tasks/ingest_hyogo_suigen.test.ts
//
// Fixtures are verbatim UTF-8 captures of 兵庫県「県内の水源の状況」
// (web.pref.hyogo.lg.jp/kk05/ac07_000000162.html):
//   - ac07_000000162_2026-09-28.html: fetched live on 2026-09-28, 【令和8年9月1日現在】,
//     13 rows with 呑吐 and 大川瀬 sharing one row.
//   - ac07_000000162_2025-08-14_wayback.html: the Wayback Machine's original-bytes
//     (id_) capture of 2025-08-14, 【令和7年8月4日現在】. The 2025 渇水 layout: a
//     取水制限 notice table above the data table, 18 rows, 呑吐 and 大川瀬 apart.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindableMaster } from '@dam/core/dam_binding';
import { chooseMaster, parseHyogoSuigen } from './ingest_hyogo_suigen.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/hyogo_suigen');

const live = await readFile(join(FIXTURES, 'ac07_000000162_2026-09-28.html'), 'utf8');
const drought = await readFile(join(FIXTURES, 'ac07_000000162_2025-08-14_wayback.html'), 'utf8');

describe('parseHyogoSuigen', () => {
  const parsed = parseHyogoSuigen(live);
  const rate = (name: string) => parsed.rows.find((r) => r.name === name)?.storageRate;

  test('stamps the survey date at 00:00 JST', () => {
    // 【令和8年9月1日現在】
    expect(parsed.observedAt?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('lists every row under its name without the furigana', () => {
    expect(parsed.rows.map((r) => r.name)).toEqual([
      '青野ダム',
      '千苅ダム',
      '丸山ダム',
      '一庫ダム',
      '加古川大堰',
      '呑吐ダム・大川瀬ダム',
      '鴨川ダム',
      '生野ダム',
      '竹原ダム',
      '猪ノ鼻ダム',
      '猪ノ鼻第二ダム',
      '成相ダム',
      '牛内ダム',
    ]);
  });

  test('keeps the two dams of a shared row apart from its label', () => {
    expect(parsed.rows.find((r) => r.name === '呑吐ダム・大川瀬ダム')).toEqual({
      name: '呑吐ダム・大川瀬ダム',
      damNames: ['呑吐ダム', '大川瀬ダム'],
      storageRate: 0.48,
    });
  });

  test('reads 貯水率 as a fraction, not the 10か年平均 column', () => {
    expect(rate('千苅ダム')).toBe(0.83);
    expect(rate('丸山ダム')).toBe(0.68);
    expect(rate('加古川大堰')).toBe(1);
    expect(rate('竹原ダム')).toBe(0.38);
    expect(rate('猪ノ鼻ダム')).toBe(0.72);
    expect(rate('猪ノ鼻第二ダム')).toBe(0.53);
    // Full-width ％.
    expect(rate('牛内ダム')).toBe(0.38);
  });

  test('reads a missing marker as null and keeps the row', () => {
    const blank = live.replace(/(<td>竹原ダム<\/td>[\s\S]*?<td>\s*<p>)38%(<\/p>)/, '$1－$2');
    const row = parseHyogoSuigen(blank).rows.find((r) => r.name === '竹原ダム');
    expect(row).toEqual({ name: '竹原ダム', damNames: ['竹原ダム'], storageRate: null });
  });

  test('reports no date when the caption is gone', () => {
    const undated = live.replace('【令和8年9月1日現在】', '');
    expect(parseHyogoSuigen(undated).observedAt).toBeNull();
  });

  test('reads the drought layout past the 取水制限 notice', () => {
    const d = parseHyogoSuigen(drought);
    expect(d.observedAt?.toISOString()).toBe('2025-08-03T15:00:00.000Z');
    expect(d.rows).toHaveLength(18);
    expect(d.rows.find((r) => r.name === '呑吐ダム')).toEqual({
      name: '呑吐ダム',
      damNames: ['呑吐ダム'],
      storageRate: 0.35,
    });
    expect(d.rows.find((r) => r.name === '加古川大堰')?.storageRate).toBe(0.65);
    expect(d.rows.find((r) => r.name === '猪ノ鼻第二ダム')?.storageRate).toBe(1);
  });
});

describe('chooseMaster', () => {
  // Real prod rows (兵庫 28).
  const masters: BindableMaster[] = [
    { id: 10194n, name: '一庫', completedYear: 1983 },
    { id: 10197n, name: '丸山', completedYear: 1977 },
    { id: 10198n, name: '千苅', completedYear: 1919 },
    { id: 10213n, name: '加古川大堰', completedYear: 1988 },
    { id: 10263n, name: '竹原', completedYear: 1962 },
    { id: 10264n, name: '猪鼻第2', completedYear: 1978 },
    { id: 10265n, name: '猪ノ鼻', completedYear: 1933 },
  ];

  test('folds ノ and 第二 so the two 猪鼻 dams stay apart', () => {
    expect(chooseMaster('猪ノ鼻ダム', masters)).toBe(10265n);
    expect(chooseMaster('猪ノ鼻第二ダム', masters)).toBe(10264n);
  });

  test('matches a weir, which carries no ダム suffix', () => {
    expect(chooseMaster('加古川大堰', masters)).toBe(10213n);
    expect(chooseMaster('千苅ダム', masters)).toBe(10198n);
  });

  test('keeps a stamped row over a name match', () => {
    const stamped = [
      ...masters,
      { id: 99999n, name: '丸山', completedYear: 2000, stamp: '丸山ダム' },
    ];
    expect(chooseMaster('丸山ダム', stamped)).toBe(99999n);
  });

  test('matches nothing for a dam without a master', () => {
    expect(chooseMaster('天川第一ダム', masters)).toBeNull();
  });
});
