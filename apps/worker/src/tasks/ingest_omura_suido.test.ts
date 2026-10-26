// apps/worker/src/tasks/ingest_omura_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 大村市上下水道局「ダム（水源）情報」
// (omura-waterworks.jp/water/) taken 2026-09-28 15:55 JST, showing the
// 「令和8年9月28日午前7時00分現在」 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { omuraEntries, parseOmuraWater } from './ingest_omura_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/omura_suido/water_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

describe('parseOmuraWater', () => {
  test('lists both facilities under their printed names', () => {
    expect(parseOmuraWater(html).rows.map((r) => r.name)).toEqual([
      '萱瀬ダム（大村市水道用水分）',
      '池田貯水池',
    ]);
  });

  test('reads 「令和8年9月28日午前7時00分現在」 as 07:00 JST', () => {
    expect(parseOmuraWater(html).observedAt?.toISOString()).toBe('2026-09-27T22:00:00.000Z');
  });

  test('reads 利水貯水量, 現在利水貯水量 in m³ and the rate as a fraction', () => {
    const ikeda = parseOmuraWater(html).rows.find((r) => r.name === '池田貯水池');
    expect(ikeda?.capacityM3).toBe(200_000);
    expect(ikeda?.storageVolumeM3).toBe(183_274);
    expect(ikeda?.storageRate).toBeCloseTo(0.916, 6);
  });

  test('午後 shifts the hour by 12', () => {
    const pm = html.replace('午前7時00分現在', '午後1時30分現在');
    expect(parseOmuraWater(pm).observedAt?.toISOString()).toBe('2026-09-28T04:30:00.000Z');
  });

  test('no 現在 line → null date', () => {
    expect(parseOmuraWater(html.replace(/現在/g, '')).observedAt).toBeNull();
  });
});

describe('omuraEntries', () => {
  const entries = (page: string) => {
    const { observedAt, rows } = parseOmuraWater(page);
    if (!observedAt) throw new Error('no date');
    return omuraEntries(observedAt, rows);
  };

  test('binds by exact stem: 池田貯水池 as 池田 (never a longer name like 池田溜池)', () => {
    expect(entries(html).map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['萱瀬ダム（大村市水道用水分）', '42', { exact: true }],
      ['池田貯水池', '42', { name: '池田', exact: true }],
    ]);
  });

  test('records both rows with values but writes only 池田, never the 萱瀬 city share', () => {
    const [kaze, ikeda] = entries(html);
    expect(kaze?.dontWrite).toContain('share');
    expect(kaze?.reading).toMatchObject({ state: 'values' });
    expect(ikeda?.dontWrite).toBeUndefined();
    expect(ikeda?.reading).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: new Date('2026-09-27T22:00:00.000Z'),
          storageVolumeM3: 183_274,
          storageRate: expect.closeTo(0.916, 6),
        },
      ],
    });
  });

  test('池田 is not written once its 利水貯水量 moves off 200,000', () => {
    const moved = html.replace(/(池田貯水池<\/a><\/td>\s*<td[^>]*>\s*)200,000/, '$1260,000');
    expect(entries(moved)[1]?.dontWrite).toContain('re-check WRITE');
  });

  test('a row whose readings do not parse is unreadable, not marked empty', () => {
    const blank = html.replace('183,274', '－').replace('91.6%', '－');
    expect(entries(blank)[1]?.reading).toMatchObject({ state: 'unreadable' });
  });
});
