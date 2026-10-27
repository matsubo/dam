// apps/worker/src/tasks/ingest_sasebo_suido.test.ts
//
// Runs against the real 佐世保市水道局 daily PDF (suiryounippou080927.pdf, the
// 令和8年9月27日 午前0時 report) and the 貯水率 page that linked it, both
// captured 2026-09-27, so the unpdf extraction is exercised along with the
// line parser.

import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  findLatestPdfUrl,
  parseSaseboPdfText,
  pdfToText,
  saseboEntries,
} from './ingest_sasebo_suido.ts';

const DIR = join(import.meta.dir, '..', '..', '..', '..', 'tests/fixtures/sasebo_suido');

const text = await pdfToText(new Uint8Array(await readFile(join(DIR, 'suiryounippou080927.pdf'))));
const parsed = parseSaseboPdfText(text);

describe('parseSaseboPdfText — the real 2026-09-27 PDF', () => {
  test('reads 令和8年9月27日 as the 午前0時 JST reading', () => {
    expect(parsed.reportDate?.toISOString()).toBe('2026-09-26T15:00:00.000Z');
  });

  test('lists the six reservoirs and neither 小計 nor 合計', () => {
    expect(parsed.rows.map((r) => r.name)).toEqual([
      '山の田',
      '菰田',
      '川谷',
      '相当',
      '転石',
      '下の原',
    ]);
  });

  test('takes 現在貯水量 in m³ and 貯水率, not the 前年同日 columns', () => {
    const kawatani = parsed.rows.find((r) => r.name === '川谷');
    expect(kawatani?.storageVolumeM3).toBe(1_310_523);
    expect(kawatani?.storageRate).toBeCloseTo(0.814, 6);
    const yamanota = parsed.rows.find((r) => r.name === '山の田');
    expect(yamanota?.storageVolumeM3).toBe(479_184);
    expect(yamanota?.storageRate).toBeCloseTo(0.87, 6);
  });

  test('reads 下の原, whose line starts with the 南部 水系 label', () => {
    const shimonohara = parsed.rows.find((r) => r.name === '下の原');
    expect(shimonohara?.storageVolumeM3).toBe(1_355_400);
    expect(shimonohara?.storageRate).toBeCloseTo(0.621, 6);
  });
});

describe('findLatestPdfUrl', () => {
  test('finds the report linked from the real 貯水率 page', async () => {
    const html = await readFile(join(DIR, 'chosuiritsu_2026-09-27.html'), 'utf8');
    expect(findLatestPdfUrl(html)).toBe(
      'https://www.city.sasebo.lg.jp/documents/809/suiryounippou080927.pdf',
    );
  });

  test('picks the newest report when several are linked', () => {
    const html =
      '<a href="/documents/809/suiryounippou080926.pdf">前日</a>' +
      '<a href="/documents/809/suiryounippou080927.pdf">当日</a>' +
      '<a href="/documents/809/suiryounippou071231.pdf">昨年</a>';
    expect(findLatestPdfUrl(html)).toBe(
      'https://www.city.sasebo.lg.jp/documents/809/suiryounippou080927.pdf',
    );
  });

  test('returns null when no report is linked', () => {
    expect(findLatestPdfUrl('<p>準備中</p>')).toBeNull();
  });
});

describe('saseboEntries', () => {
  const { reportDate, rows, published } = parsed;
  if (!reportDate) throw new Error('no date');

  test('one entry per dam line, bound by whole name only', () => {
    const entries = saseboEntries(reportDate, rows, published);
    expect(entries.map((e) => [e.key, e.pref, e.bind])).toEqual(
      ['山の田', '菰田', '川谷', '相当', '転石', '下の原'].map((n) => [n, '42', { exact: true }]),
    );
    expect(entries.find((e) => e.key === '川谷')?.reading).toEqual({
      state: 'values',
      observations: [
        {
          observedAt: reportDate,
          storageVolumeM3: 1_310_523,
          storageRate: expect.closeTo(0.814, 6),
        },
      ],
    });
  });

  test('a dam line whose readings did not parse is unreadable', () => {
    const entries = saseboEntries(reportDate, [], published);
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => 'state' in e.reading && e.reading.state === 'unreadable')).toBe(
      true,
    );
  });
});
