// Fixture: the データ table of the live smartphone page
// sp/dam/spdmObserve.aspx?stncd=015 (厚東川ダム) captured 2026-09-27 21:40 JST
// (観測日時 21:30), trimmed verbatim from <table class="tb-data"> through the
// ダム局詳細 table. The page closes none of its data <tr>s; the first </tr>
// after the data rows belongs to the ダム局詳細 table.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  parseYamaguchiHtml,
  parseYamaguchiTimestamp,
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

describe('parseYamaguchiHtml', () => {
  test('reads every on-the-hour row of the 24-hour table, oldest first', async () => {
    const rows = parseYamaguchiHtml(await fixtureHtml(), '厚東川ダム');
    // 2026-09-26 22:00 … 2026-09-27 21:00 JST. The leading 21:40 row
    // (class hour_21b) opens the window but is not an hourly reading.
    expect(rows).toHaveLength(24);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-09-26T13:00:00.000Z');
    expect(rows.at(-1)?.observedAt.toISOString()).toBe('2026-09-27T12:00:00.000Z');
  });

  test('the newest row carries the 21:00 JST readings, not the day-old first row', async () => {
    const newest = parseYamaguchiHtml(await fixtureHtml(), '厚東川ダム').at(-1);
    expect(newest?.yamaguchiName).toBe('厚東川ダム');
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
    const rows = parseYamaguchiHtml(html, '厚東川ダム');
    expect(rows).toHaveLength(23);
    expect(rows.at(-1)?.observedAt.toISOString()).toBe('2026-09-27T11:00:00.000Z');
  });

  test('reads the legend markers **** (欠測) and blank (未観測) as null', async () => {
    // Simulated: the site legend defines both markers; rewrite the 21:00 row.
    const html = (await fixtureHtml()).replace(
      '2026/09/27<br />21:00</td><td>30.90</td><td>36.6</td><td>5.91</td>',
      '2026/09/27<br />21:00</td><td>30.90</td><td>****</td><td></td>',
    );
    const newest = parseYamaguchiHtml(html, '厚東川ダム').at(-1);
    expect(newest?.waterLevelM).toBe(30.9);
    expect(newest?.storageRate).toBeNull();
    expect(newest?.inflowM3s).toBeNull();
    expect(newest?.outflowM3s).toBe(4.91);
  });

  test('returns nothing for a page without the data table', () => {
    expect(parseYamaguchiHtml('', '厚東川ダム')).toEqual([]);
  });
});

describe('chooseMaster (#79)', () => {
  test('keeps 木屋川ダム on the （元） while the （再） has no completion year', () => {
    // 0056 clears 木屋川（再）'s copied year (NDI 2022): the 嵩上げ is not finished.
    const masters = [
      { id: 10610n, name: '木屋川（元）', completedYear: 1955 },
      { id: 10622n, name: '木屋川（再）', completedYear: null },
    ];
    expect(chooseMaster('木屋川ダム', masters)).toBe(10610n);
  });
});
