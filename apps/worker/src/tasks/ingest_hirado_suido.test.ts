// apps/worker/src/tasks/ingest_hirado_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 平戸市水道局「市内水道用ダムの貯水状況に
// ついて」 (city.hirado.nagasaki.jp/kurashi/life/water/cyosuiritsu.html) taken
// 2026-09-28 15:55 JST, showing the 「令和８年９月24日現在」 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hiradoEntries, parseHiradoDams } from './ingest_hirado_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/hirado_suido/cyosuiritsu_2026-09-28.html',
);

const html = await readFile(FIXTURE, 'utf8');

function entries(page: string) {
  const { observedAt, rows } = parseHiradoDams(page);
  if (!observedAt) throw new Error('no date');
  return hiradoEntries(observedAt, rows);
}

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

describe('hiradoEntries', () => {
  test('lists all eight; 神曽根ダム is pinned to 神曽根第2 (NDI 2639), the rest bind by exact name', () => {
    expect(entries(html).map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['神曽根ダム', '42', { ndi: '2639' }],
      ['箕坪ダム', '42', { exact: true }],
      ['阿奈田ダム', '42', { exact: true }],
      ['平床の池', '42', { exact: true }],
      ['神の川ダム', '42', { exact: true }],
      ['桜川ダム', '42', { exact: true }],
      ['轟川砂防ダム', '42', { exact: true }],
      ['東流川砂防ダム', '42', { exact: true }],
    ]);
  });

  test('every row has values: 貯水量 and the rate on the 現在 date', () => {
    const volumes = entries(html).map((e) => {
      const r = e.reading;
      if (typeof r === 'function' || r.state !== 'values') throw new Error(`${e.key}: no values`);
      expect(r.observations[0]?.observedAt.toISOString()).toBe('2026-09-23T15:00:00.000Z');
      return [e.key, r.observations[0]?.storageVolumeM3];
    });
    expect(volumes.slice(0, 3)).toEqual([
      ['神曽根ダム', 89_000],
      ['箕坪ダム', 383_760],
      ['阿奈田ダム', 120_822],
    ]);
    expect(volumes.find(([k]) => k === '桜川ダム')).toEqual(['桜川ダム', 94_260]);
  });

  test('a row whose cells are blank is listed and unreadable', () => {
    const blank = html.replace('383,760㎥', '－').replace('73.8％', '－');
    const minotsubo = entries(blank).find((e) => e.key === '箕坪ダム');
    expect(minotsubo?.reading).toEqual({ state: 'unreadable', why: 'no 貯水量 or 貯水率' });
  });
});
