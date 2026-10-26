// apps/worker/src/tasks/ingest_kanagawa_suibou.test.ts
//
// Fixture → universe entries, no database: binding and writing belong to the
// ingest run (apps/worker/src/ingest/run.test.ts).
//
// Fixture is a verbatim capture (UTF-8) of 神奈川県雨量水位情報
// html/stage/15/p10202_18_3585_4_1601.html — 飯泉取水堰 水位グラフ(15分) — taken
// 2026-09-28 15:58 JST (Last-Modified 15:50). Header 「観測時刻 2026/09/28 15:45」,
// 24 rows 09/28 10:00 (8.44 m) … 15:45 (8.35 m).

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { iizumiReading, parseSuibouStage, suibouEntries } from './ingest_kanagawa_suibou.ts';

const FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'tests/fixtures/kanagawa_suibou/iizumi_1601_2026-09-28T1545.html',
);

describe('parseSuibouStage', () => {
  test('reads the station name and every 15-minute level at its JST time', async () => {
    const r = parseSuibouStage(await readFile(FIXTURE, 'utf8'));
    expect(r?.station).toBe('飯泉取水堰');
    expect(r?.readings).toHaveLength(24);
    expect(r?.readings[0]).toEqual({
      observedAt: new Date('2026-09-28T01:00:00.000Z'),
      waterLevelM: 8.44,
    });
    expect(r?.readings[23]).toEqual({
      observedAt: new Date('2026-09-28T06:45:00.000Z'),
      waterLevelM: 8.35,
    });
    expect(r?.marked).toBe(0);
  });

  test('a ** (欠測) cell drops that row only', async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace(
      'data-graph-dtkey="stage_item_data_24">8.35<',
      'data-graph-dtkey="stage_item_data_24">**<',
    );
    const r = parseSuibouStage(html);
    expect(r?.readings).toHaveLength(23);
    expect(r?.marked).toBe(1);
    expect(r?.readings.at(-1)?.observedAt.toISOString()).toBe('2026-09-28T06:30:00.000Z');
  });

  test('a window that crosses midnight takes each row date from its own MM/DD', async () => {
    const html = (await readFile(FIXTURE, 'utf8'))
      .replace('2026/09/28 15:45', '2027/01/01 05:45')
      .replace(
        '<td class="notranslate">09/28 10:00</td>',
        '<td class="notranslate">12/31 23:45</td>',
      )
      .replace('<td class="notranslate">10:15</td>', '<td class="notranslate">01/01 00:00</td>');
    const at = parseSuibouStage(html)?.readings.map((x) => x.observedAt.toISOString()) ?? [];
    expect(at[0]).toBe('2026-12-31T14:45:00.000Z');
    expect(at[1]).toBe('2026-12-31T15:00:00.000Z');
    // Undated rows follow the last MM/DD seen.
    expect(at[2]).toBe('2027-01-01T01:30:00.000Z');
  });

  test('returns null without the 観測時刻 header', async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace('2026/09/28 15:45', '');
    expect(parseSuibouStage(html)).toBeNull();
  });
});

describe('iizumiReading', () => {
  test('the 24 levels are its values', async () => {
    const r = iizumiReading(await readFile(FIXTURE, 'utf8'));
    if (r.state !== 'values') throw new Error(r.state);
    expect(r.observations).toHaveLength(24);
    expect(r.observations[23]).toEqual({
      observedAt: new Date('2026-09-28T06:45:00.000Z'),
      waterLevelM: 8.35,
    });
  });

  test('every row ** or -- is provider-marked empty', async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace(
      /(data-graph-dtkey="stage_item_data_\d+">)[^<]*</g,
      (_m, open: string) => `${open}**<`,
    );
    expect(iizumiReading(html)).toEqual({
      state: 'empty',
      mark: '** 欠測 / -- 未収集 on every row',
    });
  });

  test("another station's page is unreadable", async () => {
    const html = (await readFile(FIXTURE, 'utf8')).replace('<span>飯泉取水堰', '<span>酒匂川橋');
    expect(iizumiReading(html).state).toBe('unreadable');
  });
});

describe('suibouEntries', () => {
  test('lists both 取水堰; 飯泉 binds by its exact name, 串川 never', () => {
    const [iizumi, kushikawa] = suibouEntries(async () => '');
    expect([iizumi?.key, iizumi?.name, iizumi?.bind]).toEqual([
      '3585_4_1601',
      '飯泉取水堰',
      { exact: true },
    ]);
    expect([kushikawa?.key, kushikawa?.bind, kushikawa?.reading]).toEqual([
      '3585_4_1507',
      'never',
      { state: 'unreadable', why: 'not a dam (0209); page not read' },
    ]);
  });

  test("reads 飯泉's page through the fetcher", async () => {
    const pages: string[] = [];
    const [iizumi] = suibouEntries(async (page) => {
      pages.push(page);
      return readFile(FIXTURE, 'utf8');
    });
    if (typeof iizumi?.reading !== 'function') throw new Error('not a page reading');
    const r = await iizumi.reading(null);
    expect(pages).toEqual(['p10202_18_3585_4_1601.html']);
    expect(r.state).toBe('values');
  });
});
