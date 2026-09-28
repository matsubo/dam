// apps/worker/src/tasks/ingest_dainichigawa_lid.test.ts
//
// Fixtures are verbatim captures from dainichigawa-lid.com taken 2026-09-28
// 15:50 JST: the 大日川ダム情報 page (dam.html, 「令和８年９月２８日９時更新」,
// Last-Modified 08:35 JST) and the 令和８年９月 日別ダム情報 PDF it links
// (Last-Modified 08:33 JST, rows 9月1日–9月28日, 29/30 blank). Parsing runs
// through unpdf, so the extraction order is covered too.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  chooseMaster,
  parseDailyLinks,
  parseDailyText,
  pdfToText,
} from './ingest_dainichigawa_lid.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/dainichigawa_lid');
const PAGE_URL = 'http://dainichigawa-lid.com/dam.html';

async function septemberText(): Promise<string> {
  return pdfToText(new Uint8Array(await readFile(join(DIR, 'R8sepday-dam_2026-09-28.pdf'))));
}

describe('parseDailyLinks', () => {
  test('lists every monthly PDF newest first, with its 令和 year and month', async () => {
    const html = await readFile(join(DIR, 'dam_2026-09-28.html'), 'utf8');
    const links = parseDailyLinks(html, PAGE_URL);
    expect(links.map((l) => `${l.year}-${l.month}`)).toEqual([
      '2026-9',
      '2026-8',
      '2026-7',
      '2026-6',
      '2026-5',
      '2026-4',
    ]);
    expect(links[0]?.url).toBe('http://dainichigawa-lid.com/pdfs/R8sepday-dam.pdf');
  });
});

describe('parseDailyText', () => {
  test('reads each day at 09:00 JST, 万t as m³ and the rate as a fraction', async () => {
    const rows = parseDailyText(await septemberText(), 2026, 9);
    expect(rows).toHaveLength(28);
    expect(rows[0]?.observedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(rows[0]?.storageVolumeM3).toBe(1_031_000);
    expect(rows[0]?.storageRate).toBeCloseTo(0.538, 6);
    // The newest row matches the page's own 「１，７４６，５００トン … ９１．２％」.
    expect(rows[27]?.observedAt.toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(rows[27]?.storageVolumeM3).toBe(1_746_500);
    expect(rows[27]?.storageRate).toBeCloseTo(0.912, 6);
  });

  test('a day with a 備考 note keeps its figures, not the note', async () => {
    // 「9月9日 22.59 105.30 54.9 7.00 降水量９３ｍｍ」
    const day9 = parseDailyText(await septemberText(), 2026, 9)[8];
    expect(day9?.observedAt.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    expect(day9?.storageVolumeM3).toBe(1_053_000);
    expect(day9?.storageRate).toBeCloseTo(0.549, 6);
  });

  test('skips days not yet measured (9月29日 / 9月30日 are blank)', async () => {
    const days = parseDailyText(await septemberText(), 2026, 9).map((r) =>
      r.observedAt.toISOString().slice(0, 10),
    );
    expect(days).not.toContain('2026-09-29');
    expect(days).not.toContain('2026-09-30');
  });

  test('refuses rows whose month is not the month the link names', async () => {
    // A PDF linked as 8月 that still carries September's rows must not be
    // stamped into August.
    expect(parseDailyText(await septemberText(), 2026, 8)).toEqual([]);
  });
});

describe('chooseMaster', () => {
  const hyogo = { id: 10274n, name: '大日川', ndi: '1594', stamp: null };

  test('binds the NDI-pinned 大日川 (南あわじ市), not another same-named row', () => {
    const other = { id: 99n, name: '大日川', ndi: '9999', stamp: null };
    expect(chooseMaster([other, hyogo])).toBe(10274n);
  });

  test('a row already stamped with the station keeps it', () => {
    const stamped = { id: 77n, name: '大日川ダム', ndi: null, stamp: '大日川ダム' };
    expect(chooseMaster([hyogo, stamped])).toBe(77n);
  });

  test('no pinned or stamped row: unmatched', () => {
    expect(chooseMaster([{ id: 1n, name: '大日川', ndi: '1242', stamp: null }])).toBeNull();
  });
});
