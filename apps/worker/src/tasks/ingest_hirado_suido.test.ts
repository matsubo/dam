// apps/worker/src/tasks/ingest_hirado_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 平戸市水道局「市内水道用ダムの貯水状況に
// ついて」 (city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html) taken
// 2026-09-28 15:55 JST, showing the 「令和８年９月24日現在」 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  type HiradoMaster,
  parseHiradoDams,
  planHirado,
} from './ingest_hirado_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/hirado_suido/cyosuiritsu_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

const MASTERS: HiradoMaster[] = [
  { id: 11242n, name: '神曽根第2', ndi: '2639', completedYear: 1969, stamp: null },
  { id: 11214n, name: '箕坪', ndi: '2637', completedYear: 1979, stamp: null },
  { id: 11241n, name: '阿奈田', ndi: '2635', completedYear: 2009, stamp: null },
  { id: 11240n, name: '神の川', ndi: '2641', completedYear: 1979, stamp: null },
  { id: 11229n, name: '桜川', ndi: '2638', completedYear: 1991, stamp: null },
  { id: 11148n, name: '久吹', ndi: '2562', completedYear: 1989, stamp: null },
];

describe('parseHiradoDams', () => {
  test('lists the eight facilities and not the 8か所計 total', () => {
    expect(parseHiradoDams(html).rows.map((r) => r.name)).toEqual([
      '神曽根ダム',
      '箕坪ダム',
      '阿奈田ダム',
      '平床の池',
      '神の川ダム',
      '桜川ダム',
      '轟川砂防ダム',
      '東流川砂防ダム',
    ]);
  });

  test('reads the full-width 「（注）令和８年９月24日現在」 as 00:00 JST', () => {
    expect(parseHiradoDams(html).observedAt?.toISOString()).toBe('2026-09-23T15:00:00.000Z');
  });

  test('reads 満水量 and 貯水量 in m³ and the rate as a fraction', () => {
    const minotsubo = parseHiradoDams(html).rows.find((r) => r.name === '箕坪ダム');
    expect(minotsubo).toEqual({
      name: '箕坪ダム',
      capacityM3: 520_000,
      storageVolumeM3: 383_760,
      storageRate: 0.738,
    });
  });

  test('no 現在 note → null date', () => {
    expect(parseHiradoDams(html.replace('現在</p>', '</p>')).observedAt).toBeNull();
  });
});

describe('chooseMaster', () => {
  test('神曽根ダム is pinned to 神曽根第2 (NDI 2639)', () => {
    expect(chooseMaster('神曽根ダム', MASTERS)).toBe(11242n);
  });

  test('the pin holds when a second 神曽根 row appears in the master', () => {
    const more = [
      ...MASTERS,
      { id: 1n, name: '神曽根', ndi: '9999', completedYear: null, stamp: null },
    ];
    expect(chooseMaster('神曽根ダム', more)).toBe(11242n);
  });

  test('other dams bind by exact name', () => {
    expect(chooseMaster('神の川ダム', MASTERS)).toBe(11240n);
    expect(chooseMaster('桜川ダム', MASTERS)).toBe(11229n);
  });

  test('the pond and the 砂防 dams outside the master bind to nothing', () => {
    expect(chooseMaster('平床の池', MASTERS)).toBeNull();
    expect(chooseMaster('轟川砂防ダム', MASTERS)).toBeNull();
    expect(chooseMaster('東流川砂防ダム', MASTERS)).toBeNull();
  });
});

describe('planHirado', () => {
  test('records all eight and writes the five master dams', () => {
    const { universe, writes } = planHirado(parseHiradoDams(html).rows, MASTERS);
    expect(universe).toHaveLength(8);
    expect(universe.filter((u) => u.resolvedDamId === null).map((u) => u.externalId)).toEqual([
      '平床の池',
      '轟川砂防ダム',
      '東流川砂防ダム',
    ]);
    expect(writes.map((w) => [w.damId, w.row.storageVolumeM3])).toEqual([
      [11242n, 89_000],
      [11214n, 383_760],
      [11241n, 120_822],
      [11240n, 89_328],
      [11229n, 94_260],
    ]);
  });

  test('a row whose cells are blank is listed but not written', () => {
    const blank = html.replace('383,760㎥', '－').replace('73.8％', '－');
    const { universe, writes } = planHirado(parseHiradoDams(blank).rows, MASTERS);
    expect(universe.find((u) => u.externalId === '箕坪ダム')?.hasData).toBeNull();
    expect(writes.map((w) => w.damId)).not.toContain(11214n);
  });
});
