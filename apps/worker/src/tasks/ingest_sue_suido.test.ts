// apps/worker/src/tasks/ingest_sue_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 須恵町上下水道課「貯水率」
// (town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html) taken
// 2026-09-28 16:00 JST: 更新日 2026年09月01日, 現在の貯水率 須恵ダム 100%.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chooseMaster, parseSueRates, planSue, type SueMaster } from './ingest_sue_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/sue_suido/1394_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

const MASTERS: SueMaster[] = [
  { id: 11081n, name: '須恵', completedYear: 1964, stamp: null },
  { id: 1n, name: '須恵川', completedYear: 1990, stamp: null },
];

describe('parseSueRates', () => {
  test('reads the four 現在 rates, not the 月別 history', () => {
    expect(parseSueRates(html).rows).toEqual([
      { name: '須恵ダム', storageRate: 1 },
      { name: '中柱田貯水池', storageRate: 0.96 },
      { name: '旧男鳥溜池', storageRate: 0.98 },
      { name: '新男鳥溜池', storageRate: 1 },
    ]);
  });

  test('dates the table by 「更新日：2026年09月01日」 at 00:00 JST', () => {
    expect(parseSueRates(html).observedAt?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('no 更新日 → null date', () => {
    expect(parseSueRates(html.replace('更新日', '')).observedAt).toBeNull();
  });

  test('a blank rate cell is null, not 0', () => {
    const blank = html.replace('<td height="27" style="height:27px;">100%</td>', '<td>－</td>');
    expect(parseSueRates(blank).rows[0]).toEqual({ name: '須恵ダム', storageRate: null });
  });
});

describe('chooseMaster', () => {
  test('須恵ダム binds to 須恵 only, not a longer name', () => {
    expect(chooseMaster('須恵ダム', MASTERS)).toBe(11081n);
  });

  test('the 貯水池 / 溜池 outside the master bind to nothing', () => {
    expect(chooseMaster('中柱田貯水池', MASTERS)).toBeNull();
    expect(chooseMaster('新男鳥溜池', MASTERS)).toBeNull();
  });
});

describe('planSue', () => {
  test('records all four and writes 須恵 only', () => {
    const { universe, writes } = planSue(parseSueRates(html).rows, MASTERS);
    expect(universe.map((u) => [u.externalId, u.resolvedDamId])).toEqual([
      ['須恵ダム', 11081n],
      ['中柱田貯水池', null],
      ['旧男鳥溜池', null],
      ['新男鳥溜池', null],
    ]);
    expect(writes).toEqual([{ damId: 11081n, row: { name: '須恵ダム', storageRate: 1 } }]);
  });
});
