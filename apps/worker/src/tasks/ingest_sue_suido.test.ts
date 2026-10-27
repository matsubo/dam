// apps/worker/src/tasks/ingest_sue_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 須恵町上下水道課「貯水率」
// (town.sue.fukuoka.jp/soshiki/jogesuido/jogesuido/josuido/1394.html) taken
// 2026-09-28 16:00 JST: 更新日 2026年09月01日, 現在の貯水率 須恵ダム 100%.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSueRates, sueEntries } from './ingest_sue_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/sue_suido/1394_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

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

describe('sueEntries', () => {
  const page = parseSueRates(html);
  const observedAt = page.observedAt;
  if (!observedAt) throw new Error('fixture has a 更新日');

  test('lists all four, bound by exact name only (須恵ダム is 須恵, never a longer name)', () => {
    expect(sueEntries(observedAt, page.rows).map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['須恵ダム', '40', { exact: true }],
      ['中柱田貯水池', '40', { exact: true }],
      ['旧男鳥溜池', '40', { exact: true }],
      ['新男鳥溜池', '40', { exact: true }],
    ]);
  });

  test('reads the rate only, dated by the 更新日', () => {
    expect(sueEntries(observedAt, page.rows)[0]?.reading).toEqual({
      state: 'values',
      observations: [{ observedAt: new Date('2026-08-31T15:00:00Z'), storageRate: 1 }],
    });
  });

  test('a blank rate is unreadable', () => {
    const rows = page.rows.map((r) => (r.name === '須恵ダム' ? { ...r, storageRate: null } : r));
    expect(sueEntries(observedAt, rows)[0]?.reading).toEqual({
      state: 'unreadable',
      why: 'no 貯水率',
    });
  });
});
