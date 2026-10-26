// apps/worker/src/tasks/ingest_yonezawa_heiya.test.ts
//
// Fixture → universe entry, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixtures are UTF-8 captures of 米沢平野土地改良区「用水状況」 taken
// 2026-09-28 (a Monday, the page's update day): pages/150 (the current
// 水窪ダム用水状況 slider, 2026.9.28) and pages/169 (the 令和８年度 archive,
// 2026.4.6 – 2026.9.28 weekly). Verbatim except the CMS's echo of the
// fetching client's IP (`var remoteIp=`), replaced with 0.0.0.0.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findArchiveUrl,
  parseDamName,
  parseYonezawaReadings,
  yonezawaEntry,
} from './ingest_yonezawa_heiya.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/yonezawa_heiya');
const current = await readFile(join(DIR, 'pages-150_2026-09-28.html'), 'utf8');
const archive = await readFile(join(DIR, 'pages-169_2026-09-28.html'), 'utf8');

describe('parseYonezawaReadings', () => {
  test('reads the current value once, dated 00:00 JST, 千m3 → m³', () => {
    // The slider repeats the same caption under each of its three photos.
    expect(parseYonezawaReadings(current)).toEqual([
      { observedAt: new Date('2026-09-27T15:00:00.000Z'), storageVolumeM3: 20_343_900 },
    ]);
  });

  test('reads every weekly value of the fiscal-year archive', () => {
    const rows = parseYonezawaReadings(archive);
    expect(rows).toHaveLength(26);
    expect(rows[0]).toEqual({
      observedAt: new Date('2026-04-05T15:00:00.000Z'),
      storageVolumeM3: 25_272_300,
    });
    // 「31,000.0千m3」 on 5/7 (a Thursday, after the 連休): full.
    expect(
      rows.find((r) => r.observedAt.toISOString() === '2026-05-06T15:00:00.000Z')?.storageVolumeM3,
    ).toBe(31_000_000);
  });

  test('accepts the full-width ｍ the page sometimes types', () => {
    // 2026.8.31 is captioned 「19,924.9千ｍ3です。」.
    expect(
      parseYonezawaReadings(archive).find(
        (r) => r.observedAt.toISOString() === '2026-08-30T15:00:00.000Z',
      )?.storageVolumeM3,
    ).toBe(19_924_900);
  });
});

describe('parseDamName', () => {
  test('names the dam from the page heading', () => {
    expect(parseDamName(current)).toBe('水窪ダム');
  });
});

describe('findArchiveUrl', () => {
  test('follows the current fiscal year link, not an older year', () => {
    expect(findArchiveUrl(current, 'https://www.yonezawa-heiya.or.jp/pages/150/')).toBe(
      'https://www.yonezawa-heiya.or.jp/pages/169/',
    );
  });
});

describe('yonezawaEntry', () => {
  test('one dam in 山形, bound by its exact name (静岡 has another 水窪)', () => {
    const e = yonezawaEntry(current, archive);
    expect(e).toMatchObject({
      key: '水窪ダム',
      name: '水窪ダム',
      pref: '06',
      bind: { exact: true },
    });
  });

  test('merges the current page and the archive, one reading per date', () => {
    const r = yonezawaEntry(current, archive).reading;
    if (typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    // 2026.9.28 is on both pages.
    expect(r.observations).toHaveLength(26);
  });

  test('an archive that could not be read still leaves the current value', () => {
    const r = yonezawaEntry(current, null).reading;
    if (typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations).toHaveLength(1);
  });

  test('no caption is unreadable; no heading fails the scan', () => {
    const r = yonezawaEntry(current.replace(/現在、貯水量は/g, ''), null).reading;
    expect(typeof r !== 'function' && r.state).toBe('unreadable');
    expect(() => yonezawaEntry('<p>準備中</p>', null)).toThrow('heading');
  });
});
