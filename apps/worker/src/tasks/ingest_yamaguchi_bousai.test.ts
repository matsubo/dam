// Fixture: the データ table of the live smartphone page
// sp/dam/spdmObserve.aspx?stncd=015 (厚東川ダム) captured 2026-09-27 21:40 JST
// (観測日時 21:30), trimmed verbatim from <table class="tb-data"> through the
// ダム局詳細 table. The page closes none of its data <tr>s; the first </tr>
// after the data rows belongs to the ダム局詳細 table.
//
// Page → reading and catalogue → entries, no database: binding and writing
// belong to the ingest run (apps/worker/src/ingest/run.test.ts).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Observed, Reading } from '../ingest/types.ts';
import {
  parseYamaguchiTimestamp,
  yamaguchiEntries,
  yamaguchiReading,
} from './ingest_yamaguchi_bousai.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/yamaguchi_bousai/spdmObserve_015_2026-09-27T2130.html',
);

async function fixtureHtml(): Promise<string> {
  return readFile(FIXTURE, 'utf8');
}

function rows(html: string): readonly Observed[] {
  const r = yamaguchiReading(html);
  return r.state === 'values' ? r.observations : [];
}

describe('parseYamaguchiTimestamp', () => {
  test('parses "YYYY/MM/DD HH:MM" (JST) → UTC', () => {
    const d = parseYamaguchiTimestamp('2026/06/05 21:00');
    expect(d?.toISOString()).toBe('2026-06-05T12:00:00.000Z');
  });

  test('midnight crossover: JST 00:00 → previous UTC day', () => {
    const d = parseYamaguchiTimestamp('2026/06/05 00:00');
    expect(d?.toISOString()).toBe('2026-06-04T15:00:00.000Z');
  });

  test('returns null for malformed strings', () => {
    expect(parseYamaguchiTimestamp('')).toBeNull();
    expect(parseYamaguchiTimestamp('2026-06-05 21:00')).toBeNull();
    expect(parseYamaguchiTimestamp('bad')).toBeNull();
  });
});

describe('yamaguchiReading', () => {
  test('reads every on-the-hour row of the 24-hour table, oldest first', async () => {
    const list = rows(await fixtureHtml());
    // 2026-09-26 22:00 … 2026-09-27 21:00 JST. The leading 21:40 row
    // (class hour_21b) opens the window but is not an hourly reading.
    expect(list).toHaveLength(24);
    expect(list[0]?.observedAt.toISOString()).toBe('2026-09-26T13:00:00.000Z');
    expect(list.at(-1)?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('the newest row carries the 21:00 JST readings, not the day-old first row', async () => {
    const newest = rows(await fixtureHtml()).at(-1);
    expect(newest?.waterLevelM).toBe(30.9);
    expect(newest?.storageRate).toBeCloseTo(0.366, 6);
    expect(newest?.inflowM3s).toBe(5.91);
    expect(newest?.outflowM3s).toBe(4.91);
  });

  test('drops an outage row the page prints as 貯水位 0.00', async () => {
    // Simulated: prod holds 283 yamaguchi-bousai rows (10 dams, 2026-06..09)
    // with 貯水位/貯水率/流入量/放流量 all 0 (see deploy/ops/oneoff/
    // 2026-09-28_yamaguchi_bousai_outage_zeros.sql). Rewrite the fixture's
    // 21:00 row into that shape.
    const html = (await fixtureHtml()).replace(
      '2026/09/27<br />21:00</td><td>30.90</td><td>36.6</td><td>5.91</td><td>4.91</td>',
      '2026/09/27<br />21:00</td><td>0.00</td><td>0.0</td><td>0.00</td><td>0.00</td>',
    );
    const list = rows(html);
    expect(list).toHaveLength(23);
    expect(list.at(-1)?.observedAt.toISOString()).toBe('2026-09-27T11:00:00.000Z');
  });

  test('a page of outage rows only is unreadable', () => {
    const html =
      '<table><tr class="hour_21"><td>2026/09/27<br />21:00</td><td>0.00</td><td>0.0</td><td>0.00</td><td>0.00</td></table>';
    expect(yamaguchiReading(html).state).toBe('unreadable');
  });

  test('reads the legend markers **** (欠測) and blank (未観測) as null', async () => {
    // Simulated: the site legend defines both markers; rewrite the 21:00 row.
    const html = (await fixtureHtml()).replace(
      '2026/09/27<br />21:00</td><td>30.90</td><td>36.6</td><td>5.91</td>',
      '2026/09/27<br />21:00</td><td>30.90</td><td>****</td><td></td>',
    );
    const newest = rows(html).at(-1);
    expect(newest?.waterLevelM).toBe(30.9);
    expect(newest?.storageRate).toBeNull();
    expect(newest?.inflowM3s).toBeNull();
    expect(newest?.outflowM3s).toBe(4.91);
  });

  test('a page whose every hourly row is **** or blank is provider-marked empty', () => {
    const html =
      '<table><tr class="hour_21"><td>2026/09/27<br />21:00</td><td>****</td><td>****</td><td></td><td></td></table>';
    expect(yamaguchiReading(html).state).toBe('empty');
  });

  test('a page without the data table is unreadable', () => {
    expect(yamaguchiReading('').state).toBe('unreadable');
  });
});

describe('yamaguchiEntries', () => {
  test('lists all 23 catalogued stations, keyed by stncd, unfetched ones unreadable', () => {
    const reading: Reading = { state: 'empty', mark: 'x' };
    const list = yamaguchiEntries(new Map([['015', reading]]));
    expect(list).toHaveLength(23);
    expect(list.find((e) => e.key === '015')?.reading).toBe(reading);
    expect(list.find((e) => e.key === '015')?.name).toBe('厚東川ダム');
    expect((list.find((e) => e.key === '001')?.reading as Reading | undefined)?.state).toBe(
      'unreadable',
    );
  });

  test('looks up 小瀬川ダム in 広島 as well: the master files it under pref 34', () => {
    const list = yamaguchiEntries(new Map());
    expect(list.find((e) => e.name === '小瀬川ダム')?.pref).toEqual(['34', '35']);
    expect(list.find((e) => e.name === '厚東川ダム')?.pref).toBe('35');
  });
});
