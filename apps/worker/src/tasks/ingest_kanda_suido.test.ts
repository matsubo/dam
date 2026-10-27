// apps/worker/src/tasks/ingest_kanda_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 苅田町水道課「水道の安定供給と安全性」
// (town.kanda.lg.jp/page/2021.html) taken 2026-09-28 15:55 JST, showing the
// 「令和 8年 9月 28日現在」 水源の状況 table (更新日 2026年9月28日).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kandaEntries, parseKandaSuigen } from './ingest_kanda_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kanda_suido/2021_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

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

describe('kandaEntries', () => {
  const { observedAt, rows } = parseKandaSuigen(html);
  if (!observedAt) throw new Error('no date');
  const entries = kandaEntries(observedAt, rows);

  test('山口ダム is pinned to 福岡県の山口 (NDI 2248), not 山口調整池; the rest bind by exact name', () => {
    expect(entries.map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['油木ダム', '40', { exact: true }],
      ['山口ダム', '40', { ndi: '2248' }],
      ['井ノ口池', '40', { exact: true }],
    ]);
  });

  test('every row reads its volume and rate at the 現在 date', () => {
    const read = entries.map((e) => {
      const r = e.reading;
      if (typeof r === 'function' || r.state !== 'values') throw new Error(`${e.key}: no values`);
      expect(r.observations[0]?.observedAt).toEqual(observedAt);
      return r.observations[0];
    });
    expect(read.map((o) => o?.storageVolumeM3)).toEqual([6_463_000, 633_000, expect.any(Number)]);
    expect(read[0]?.storageRate).toBeCloseTo(0.447, 6);
  });

  test('a row whose cells are blank is listed and unreadable', () => {
    const blank = parseKandaSuigen(html).rows.map((r) =>
      r.name === '山口ダム' ? { ...r, storageVolumeM3: null, storageRate: null } : r,
    );
    expect(kandaEntries(observedAt, blank)[1]?.reading).toEqual({
      state: 'unreadable',
      why: 'no 貯水量 or 貯水率',
    });
  });
});
