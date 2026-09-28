// apps/worker/src/tasks/ingest_omura_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 大村市上下水道局「ダム（水源）情報」
// (omura-waterworks.jp/water/) taken 2026-09-28 15:55 JST, showing the
// 「令和8年9月28日午前7時00分現在」 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  type OmuraMaster,
  parseOmuraWater,
  planOmura,
} from './ingest_omura_suido.ts';

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

describe('chooseMaster', () => {
  const masters: OmuraMaster[] = [
    { id: 1n, name: '池田（元）', completedYear: 1952, stamp: null },
    { id: 2n, name: '池田（再）', completedYear: 1986, stamp: null },
    { id: 3n, name: '萱瀬（元）', completedYear: 1961, stamp: null },
    { id: 4n, name: '萱瀬（再）', completedYear: 2000, stamp: null },
    { id: 5n, name: '池田溜池', completedYear: 1950, stamp: null },
  ];

  test('池田貯水池 goes to the completed （再）, not the （元） or a longer name', () => {
    expect(chooseMaster('池田貯水池', masters)).toBe(2n);
  });

  test('the 萱瀬 share row resolves to the live 萱瀬（再）', () => {
    expect(chooseMaster('萱瀬ダム（大村市水道用水分）', masters)).toBe(4n);
  });

  test('a stamped row keeps the station', () => {
    const stamped = masters.map((m) => (m.id === 1n ? { ...m, stamp: '池田貯水池' } : m));
    expect(chooseMaster('池田貯水池', stamped)).toBe(1n);
  });

  test('an unknown name binds to nothing', () => {
    expect(chooseMaster('野田貯水池', masters)).toBeNull();
  });
});

describe('planOmura', () => {
  const masters: OmuraMaster[] = [
    { id: 2n, name: '池田（再）', completedYear: 1986, stamp: null },
    { id: 4n, name: '萱瀬（再）', completedYear: 2000, stamp: null },
  ];

  test('records both rows but writes only 池田, never the 萱瀬 city share', () => {
    const plan = planOmura(parseOmuraWater(html).rows, masters);
    expect(plan.universe.map((u) => [u.externalId, u.resolvedDamId, u.hasData])).toEqual([
      ['萱瀬ダム（大村市水道用水分）', 4n, true],
      ['池田貯水池', 2n, true],
    ]);
    expect(plan.writes.map((w) => [w.damId, w.row.storageVolumeM3])).toEqual([[2n, 183_274]]);
    expect(plan.drift).toEqual([]);
  });

  test('池田 is not written once its 利水貯水量 moves off 200,000', () => {
    const moved = html.replace(/(池田貯水池<\/a><\/td>\s*<td[^>]*>\s*)200,000/, '$1260,000');
    const plan = planOmura(parseOmuraWater(moved).rows, masters);
    expect(plan.writes).toEqual([]);
    expect(plan.drift).toHaveLength(1);
  });
});
