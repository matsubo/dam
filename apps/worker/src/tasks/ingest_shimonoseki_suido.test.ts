// apps/worker/src/tasks/ingest_shimonoseki_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 下関市上下水道局「水源状況についてお知らせします」
// (city.shimonoseki.lg.jp/site/water/5617.html) taken 2026-09-28 JST, showing
// the 令和8年9月25日現在 table (当日午前0時 values; 更新日 2026-09-25).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BindableMaster } from '@dam/core/dam_binding';
import { chooseMaster, parseShimonosekiSuigen } from './ingest_shimonoseki_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/shimonoseki_suido/suigen_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

describe('parseShimonosekiSuigen', () => {
  test('lists the three 施設 of the 貯水量 table, not 合計 nor the 降水量 table', () => {
    const { rows } = parseShimonosekiSuigen(html);
    expect(rows.map((r) => r.name)).toEqual(['木屋川ダム', '湯の原ダム', '内日貯水池']);
  });

  test('reads 「令和8年9月25日現在」 split across <strong> tags as 00:00 JST', () => {
    expect(parseShimonosekiSuigen(html).observedAt?.toISOString()).toBe('2026-09-24T15:00:00.000Z');
  });

  test('stores 立方メートル as m³ and the rate as a fraction', () => {
    const yunohara = parseShimonosekiSuigen(html).rows.find((r) => r.name === '湯の原ダム');
    expect(yunohara?.storageVolumeM3).toBe(507_000);
    expect(yunohara?.storageRate).toBeCloseTo(0.247, 6);
  });

  test('a cell without a number reads as null, not 0', () => {
    const blank = html.replace('507,000立方メートル', '－').replace('24.7%', '欠測');
    const yunohara = parseShimonosekiSuigen(blank).rows.find((r) => r.name === '湯の原ダム');
    expect(yunohara?.storageVolumeM3).toBeNull();
    expect(yunohara?.storageRate).toBeNull();
  });

  test('令和元年 is 2019', () => {
    const gannen = html.replace('<strong>令和8年9</strong>', '<strong>令和元年5</strong>');
    expect(parseShimonosekiSuigen(gannen).observedAt?.toISOString()).toBe(
      '2019-05-24T15:00:00.000Z',
    );
  });

  test('no 「…日現在」 line → no date', () => {
    expect(parseShimonosekiSuigen(html.replace('現在の下関市', 'の下関市')).observedAt).toBeNull();
  });
});

describe('chooseMaster', () => {
  // Real prod rows (山口 35) that the published names could reach.
  const masters: BindableMaster[] = [
    { id: 10578n, name: '内日第1', completedYear: 1906 },
    { id: 10579n, name: '内日第2', completedYear: 1928 },
    { id: 10610n, name: '木屋川（元）', completedYear: 1955 },
    { id: 10611n, name: '湯の原', completedYear: 1990 },
    { id: 10614n, name: '内日', completedYear: 1990 },
    { id: 10622n, name: '木屋川（再）', completedYear: null },
  ];

  test('湯の原ダム binds to 湯の原 (NDI 2024)', () => {
    expect(chooseMaster('湯の原ダム', masters)).toBe(10611n);
  });

  test('木屋川ダム resolves to the completed （元） while the （再） is unbuilt', () => {
    expect(chooseMaster('木屋川ダム', masters)).toBe(10610n);
  });

  test('refuses 内日貯水池: the combined 第1 + 第2 figure, never the 県 内日ダム', () => {
    expect(chooseMaster('内日貯水池', masters)).toBeNull();
    const stamped = masters.map((m) => (m.id === 10614n ? { ...m, stamp: '内日貯水池' } : m));
    expect(chooseMaster('内日貯水池', stamped)).toBeNull();
  });

  test('a row already stamped with the facility keeps it', () => {
    const stamped = masters.map((m) => (m.id === 10622n ? { ...m, stamp: '木屋川ダム' } : m));
    expect(chooseMaster('木屋川ダム', stamped)).toBe(10622n);
  });

  test('an unknown facility binds to nothing', () => {
    expect(chooseMaster('豊田浄水場', masters)).toBeNull();
  });
});
