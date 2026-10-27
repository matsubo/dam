// apps/worker/src/tasks/ingest_matsue_suido.test.ts
//
// Fixture is a verbatim UTF-8 capture of 松江市上下水道局「千本ダム・大谷ダム
// 貯水量・貯水率」 (water.matsue.shimane.jp/shiryo/chosui-list.html) taken
// 2026-09-27: a 2026年9月 table (1日–25日) and a 2026年8月 table (1日–31日).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { matsueEntries, parseMatsueChosuiList } from './ingest_matsue_suido.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/matsue_suido/chosui-list_2026-09-27.html',
);

const html = await readFile(FIXTURE, 'utf8');
const rows = parseMatsueChosuiList(html);

function at(name: string, iso: string) {
  return rows.find((r) => r.name === name && r.observedAt.toISOString() === iso);
}

describe('parseMatsueChosuiList', () => {
  test('reads both dams for every day of both monthly tables', () => {
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(['千本ダム', '大谷ダム']));
    expect(rows).toHaveLength(2 * (25 + 31));
  });

  test('dates each day from its table caption, at 00:00 JST', () => {
    // 「２０２６年９ 月」 caption, typeset in full-width digits across two spans.
    expect(at('千本ダム', '2026-09-24T15:00:00.000Z')).toEqual({
      name: '千本ダム',
      observedAt: new Date('2026-09-24T15:00:00.000Z'),
      storageVolumeM3: 280_269,
      storageRate: 0.74,
    });
  });

  test('keeps the previous month under its own caption', () => {
    const ootani = at('大谷ダム', '2026-08-30T15:00:00.000Z');
    expect(ootani?.storageVolumeM3).toBe(988_911);
    expect(ootani?.storageRate).toBeCloseTo(0.745, 6);
  });

  test('reads a full reservoir as 100 %', () => {
    expect(at('千本ダム', '2026-09-06T15:00:00.000Z')?.storageRate).toBe(1);
  });

  test('skips a day whose cells are still blank', () => {
    const blank = html.replace(
      /<td style="text-align: right;">25日<\/td>\s*<td[^>]*>280,269<\/td>\s*<td[^>]*>74\.0<\/td>/,
      '<td style="text-align: right;">25日</td><td></td><td></td>',
    );
    const parsed = parseMatsueChosuiList(blank);
    expect(
      parsed.find(
        (r) => r.name === '千本ダム' && r.observedAt.toISOString() === '2026-09-24T15:00:00.000Z',
      ),
    ).toBeUndefined();
    expect(
      parsed.find(
        (r) => r.name === '大谷ダム' && r.observedAt.toISOString() === '2026-09-24T15:00:00.000Z',
      )?.storageVolumeM3,
    ).toBe(970_296);
  });
});

describe('matsueEntries', () => {
  test('one entry per dam, bound by exact name, carrying every day of both tables', () => {
    const entries = matsueEntries(html);
    expect(entries.map((e) => [e.key, e.pref, e.bind])).toEqual([
      ['千本ダム', '32', { exact: true }],
      ['大谷ダム', '32', { exact: true }],
    ]);
    const r = entries[0]?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations).toHaveLength(25 + 31);
    expect(r.observations).toContainEqual({
      observedAt: new Date('2026-09-24T15:00:00.000Z'),
      storageVolumeM3: 280_269,
      storageRate: 0.74,
    });
  });

  test('a dam whose every day is blank is listed and unreadable', () => {
    const blank = html.replace(
      /(<td[^>]*>\d+日<\/td>\s*)<td[^>]*>[\d,]+<\/td>\s*<td[^>]*>[\d.]+<\/td>/g,
      '$1<td></td><td></td>',
    );
    const [senbon, ootani] = matsueEntries(blank);
    expect(senbon?.reading).toMatchObject({ state: 'unreadable' });
    expect(ootani?.reading).toMatchObject({ state: 'values' });
  });
});
