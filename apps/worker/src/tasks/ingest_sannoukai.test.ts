// apps/worker/src/tasks/ingest_sannoukai.test.ts
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
import type { BindableMaster } from '@dam/core/dam_binding';
import {
  chooseMaster,
  findRestUrl,
  observedAtFromRest,
  parseSannoukaiPage,
} from './ingest_sannoukai.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/sannoukai');
const html = await readFile(join(DIR, 'condition_2026-09-28.html'), 'utf8');
const rest = JSON.parse(await readFile(join(DIR, 'wp-json-pages-52_2026-09-28.json'), 'utf8'));

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

describe('findRestUrl', () => {
  test('follows the page’s own REST alternate link', () => {
    expect(findRestUrl(html)).toBe('https://sannoukai.jp/wp-json/wp/v2/pages/52');
  });
});

describe('observedAtFromRest', () => {
  test('stamps the JST date of the last edit at 00:00 JST', () => {
    // 2026-09-27T23:46:17Z is Monday 09-28 08:46 JST.
    expect(observedAtFromRest(rest)).toEqual(new Date('2026-09-27T15:00:00.000Z'));
  });

  test('rejects a record without modified_gmt', () => {
    expect(observedAtFromRest({ id: 52 })).toBeNull();
  });
});

describe('chooseMaster', () => {
  // Real prod rows (岩手 03): 山王海 has a （元） (1952) and the redeveloped
  // （再） (2001) that holds today's reservoir.
  const masters: BindableMaster[] = [
    { id: 9256n, name: '山王海（元）', completedYear: 1952 },
    { id: 9257n, name: '山王海（再）', completedYear: 2001 },
    { id: 9259n, name: '葛丸', completedYear: 1991 },
  ];

  test('binds 山王海ダム to the completed （再） twin', () => {
    expect(chooseMaster('山王海ダム', masters)).toBe(9257n);
  });

  test('binds 葛丸ダム by name', () => {
    expect(chooseMaster('葛丸ダム', masters)).toBe(9259n);
  });
});
