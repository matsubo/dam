// apps/worker/src/tasks/ingest_hyogo_suigen.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
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
import type { Entry, Reading } from '../ingest/types.ts';
import { hyogoSuigenEntries, parseHyogoSuigen } from './ingest_hyogo_suigen.ts';

const FIXTURES = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/hyogo_suigen');

const live = await readFile(join(FIXTURES, 'ac07_000000162_2026-09-28.html'), 'utf8');
const drought = await readFile(join(FIXTURES, 'ac07_000000162_2025-08-14_wayback.html'), 'utf8');

function readingOf(list: Entry[], name: string): Reading {
  const r = list.find((e) => e.name === name)?.reading;
  if (!r || typeof r === 'function') throw new Error(`no reading for ${name}`);
  return r;
}

function rateOf(list: Entry[], name: string): number | null | undefined {
  const r = readingOf(list, name);
  return r.state === 'values' ? r.observations[0]?.storageRate : undefined;
}

describe('parseHyogoSuigen', () => {
  const parsed = parseHyogoSuigen(live);

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
      rateCell: '48%',
    });
  });

  test('reports no date when the caption is gone', () => {
    const undated = live.replace('【令和8年9月1日現在】', '');
    expect(parseHyogoSuigen(undated).observedAt).toBeNull();
  });
});

describe('hyogoSuigenEntries', () => {
  const entries = hyogoSuigenEntries(live);

  test('reads 貯水率 as a fraction at the survey date, not the 10か年平均 column', () => {
    expect(rateOf(entries, '千苅ダム')).toBe(0.83);
    expect(rateOf(entries, '丸山ダム')).toBe(0.68);
    expect(rateOf(entries, '加古川大堰')).toBe(1);
    expect(rateOf(entries, '竹原ダム')).toBe(0.38);
    expect(rateOf(entries, '猪ノ鼻ダム')).toBe(0.72);
    expect(rateOf(entries, '猪ノ鼻第二ダム')).toBe(0.53);
    // Full-width ％.
    expect(rateOf(entries, '牛内ダム')).toBe(0.38);
    const r = readingOf(entries, '千苅ダム');
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('a missing marker is provider-marked empty, and the row stays listed', () => {
    const blank = live.replace(/(<td>竹原ダム<\/td>[\s\S]*?<td>\s*<p>)38%(<\/p>)/, '$1－$2');
    expect(readingOf(hyogoSuigenEntries(blank), '竹原ダム')).toEqual({
      state: 'empty',
      mark: '-',
    });
  });

  test('without the 【…現在】 caption every row is unreadable', () => {
    const undated = hyogoSuigenEntries(live.replace('【令和8年9月1日現在】', ''));
    expect(readingOf(undated, '千苅ダム').state).toBe('unreadable');
  });

  test('binds by exact name only; the shared row binds nothing', () => {
    const bind = (name: string) => entries.find((e) => e.name === name)?.bind;
    expect(bind('千苅ダム')).toEqual({ name: '千苅ダム', exact: true });
    // A weir, which carries no ダム suffix.
    expect(bind('加古川大堰')).toEqual({ name: '加古川大堰', exact: true });
    // One figure for two dams belongs to neither.
    expect(bind('呑吐ダム・大川瀬ダム')).toBe('never');
  });

  test('looks up 猪ノ鼻（いのはな）第二ダム as the master 猪鼻第2, apart from 猪ノ鼻', () => {
    const bind = (name: string) => entries.find((e) => e.name === name)?.bind;
    expect(bind('猪ノ鼻第二ダム')).toEqual({ name: '猪鼻第2', exact: true });
    expect(bind('猪ノ鼻ダム')).toEqual({ name: '猪ノ鼻ダム', exact: true });
  });

  test('records the dams another feed carries with volumes, but never writes them', () => {
    const dontWrite = entries.filter((e) => e.dontWrite).map((e) => e.name);
    expect(dontWrite).toEqual([
      '青野ダム',
      '一庫ダム',
      '生野ダム',
      '竹原ダム',
      '猪ノ鼻ダム',
      '猪ノ鼻第二ダム',
      '成相ダム',
      '牛内ダム',
    ]);
  });

  test('reads the drought layout past the 取水制限 notice', () => {
    expect(parseHyogoSuigen(drought).observedAt?.toISOString()).toBe('2025-08-03T15:00:00.000Z');
    const d = hyogoSuigenEntries(drought);
    expect(d).toHaveLength(18);
    expect(rateOf(d, '呑吐ダム')).toBe(0.35);
    expect(d.find((e) => e.name === '呑吐ダム')?.bind).toEqual({ name: '呑吐ダム', exact: true });
    expect(rateOf(d, '加古川大堰')).toBe(0.65);
    expect(rateOf(d, '猪ノ鼻第二ダム')).toBe(1);
  });
});
