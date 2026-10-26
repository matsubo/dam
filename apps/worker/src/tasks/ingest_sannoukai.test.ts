// apps/worker/src/tasks/ingest_sannoukai.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixtures are verbatim UTF-8 captures of 山王海土地改良区「ダムの状況」
// (sannoukai.jp/condition/) and its WordPress REST record
// (wp-json/wp/v2/pages/52), taken 2026-09-28 JST — a Monday, the page's
// update day. The HTML carries the readings in inline script
// (`var sNow = 1833;` 山王海, `var kNow = 432;` 葛丸, 万㎥); the REST record
// carries the edit time (modified_gmt 2026-09-27T23:46:17 = 09-28 08:46 JST).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findRestUrl,
  observedAtFromRest,
  parseSannoukaiPage,
  sannoukaiEntries,
} from './ingest_sannoukai.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/sannoukai');
const html = await readFile(join(DIR, 'condition_2026-09-28.html'), 'utf8');
const rest = JSON.parse(await readFile(join(DIR, 'wp-json-pages-52_2026-09-28.json'), 'utf8'));
const AT = new Date('2026-09-27T15:00:00.000Z');

describe('parseSannoukaiPage', () => {
  test('reads both dams by their heading, 万㎥ → m³', () => {
    expect(parseSannoukaiPage(html)).toEqual([
      { name: '山王海ダム', storageVolumeM3: 18_330_000, markedEmpty: false },
      { name: '葛丸ダム', storageVolumeM3: 4_320_000, markedEmpty: false },
    ]);
  });

  test('a zero reading is the page’s own "no data" marker, not an empty reservoir', () => {
    // The page swaps in its 'zero' error text instead of drawing 0 %.
    const zero = html.replace('var kNow = 432;', 'var kNow = 0;');
    expect(parseSannoukaiPage(zero)[1]).toEqual({
      name: '葛丸ダム',
      storageVolumeM3: null,
      markedEmpty: true,
    });
  });

  test('keeps a dam whose script value is missing, with no reading', () => {
    const missing = html.replace('var sNow = 1833;', '');
    expect(parseSannoukaiPage(missing)[0]).toEqual({
      name: '山王海ダム',
      storageVolumeM3: null,
      markedEmpty: false,
    });
  });
});

describe('sannoukaiEntries', () => {
  const states = (page: string, at: Date | null) =>
    sannoukaiEntries(page, at).map((e) => (typeof e.reading === 'function' ? null : e.reading));

  test('both dams, by exact name (山王海 binds the live （再） twin, never a prefix)', () => {
    const entries = sannoukaiEntries(html, AT);
    expect(entries.map((e) => [e.key, e.name, e.pref, e.bind])).toEqual([
      ['山王海ダム', '山王海ダム', '03', { exact: true }],
      ['葛丸ダム', '葛丸ダム', '03', { exact: true }],
    ]);
    expect(states(html, AT)[0]).toEqual({
      state: 'values',
      observations: [{ observedAt: AT, storageVolumeM3: 18_330_000 }],
    });
  });

  test('the page’s 0 marker is provider-marked empty; a missing value is unreadable', () => {
    const page = html.replace('var kNow = 432;', 'var kNow = 0;').replace('var sNow = 1833;', '');
    expect(states(page, AT).map((r) => r?.state)).toEqual(['unreadable', 'empty']);
  });

  test('without an edit date nothing can be dated: values become unreadable', () => {
    expect(states(html, null).map((r) => r?.state)).toEqual(['unreadable', 'unreadable']);
  });
});

describe('findRestUrl', () => {
  test('follows the page’s own REST alternate link', () => {
    expect(findRestUrl(html)).toBe('https://sannoukai.jp/wp-json/wp/v2/pages/52');
  });
});

describe('observedAtFromRest', () => {
  test('stamps the JST date of the last edit at 00:00 JST', () => {
    // 2026-09-27T23:46:17Z is Monday 09-28 08:46 JST.
    expect(observedAtFromRest(rest)).toEqual(AT);
  });

  test('rejects a record without modified_gmt', () => {
    expect(observedAtFromRest({ id: 52 })).toBeNull();
  });
});
