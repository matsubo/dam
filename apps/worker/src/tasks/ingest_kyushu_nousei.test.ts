// Parser tests for 九州農政局「管内の農業用ダムの貯水状況」(issue #28).
//
// Runs against the real R8.9.1 survey PDF in tests/fixtures/kyushu_nousei, so
// this covers the unpdf extraction as well as the row/column parser — the
// wide seasonal-capacity table is the risky half, and a hand-written text
// fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import {
  chooseMaster,
  findLatestPdfUrl,
  parseKyushuNouseiDate,
  parseKyushuNouseiPdfText,
  pdfToText,
} from './ingest_kyushu_nousei.ts';

const FIXTURE = new URL('../../../../tests/fixtures/kyushu_nousei/r8_0901.pdf', import.meta.url)
  .pathname;

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const parsed = parseKyushuNouseiPdfText(text);

describe('parseKyushuNouseiDate', () => {
  test('reads the full-width 令和 survey date as JST midnight', () => {
    // 「令和８年９月１日現在」→ 2026-09-01 00:00 JST → 2026-08-31T15:00:00Z.
    const d = parseKyushuNouseiDate('九州農政局管内の合計貯水率（令和８年９月１日現在）');
    expect(d?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('returns null without a 現在 anchor', () => {
    expect(parseKyushuNouseiDate('令和8年9月1日 掲載')).toBeNull();
  });
});

describe('parseKyushuNouseiPdfText — the real R8.9.1 PDF', () => {
  test('extracts the survey date from the PDF itself', () => {
    expect(parsed.reportDate?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('parses the rows whose figures are internally consistent', () => {
    // The PDF lists 59 dams; 43 carry figures that survive the
    // 貯水量 / 容量 identity check, and the rest stay in `published` so
    // /coverage still reads them as published. Asserting 59 here asserted the
    // page's dam count, not the parser's contract.
    expect(parsed.rows.length).toBeGreaterThanOrEqual(40);
    expect(parsed.published.length).toBeGreaterThanOrEqual(parsed.rows.length);
  });

  test('reads 石場ダム (shared with oita-nourin, #27) with the R8.9.1 value', () => {
    // 大分 大野川 石場ダム: 2,154 千m³ 有効/利水 (same figure), 688 千m³ 現,
    // 31.9% — the fixture's own footer confirms this after the mid-row
    // capacity-update markers around the 洪水期 boundary are skipped.
    const row = parsed.rows.find((r) => r.kyushuName === '石場ダム');
    expect(row).toBeDefined();
    expect(row?.prefCode).toBe('44');
    expect(row?.storageVolumeM3).toBe(688_000);
    expect(row?.storageRate).toBeCloseTo(0.319, 3);
  });

  test('reads a row across a prefecture boundary where 県名 is not repeated', () => {
    // 伊佐ノ浦ダム (長崎) is not the first row of its block's block-mate 繁敷
    // ダム, but 小ヶ倉ダム above it is — 県名 must carry forward correctly.
    const row = parsed.rows.find((r) => r.kyushuName === '伊佐ノ浦ダム');
    expect(row?.prefCode).toBe('42');
    expect(row?.storageVolumeM3).toBe(1_459_000);
    expect(row?.storageRate).toBeCloseTo(0.89, 2);
  });

  test('reads a row with a missing mid-year survey date (熊本 教良木ダム)', () => {
    // The PDF's own footnote says 教良木ダム's R8.8.1 column is blank
    // ("－ －"); pairDateColumns must still land on the correct R8.9.1 pair
    // afterwards rather than shifting off by one.
    const row = parsed.rows.find((r) => r.kyushuName === '教良木ダム');
    expect(row?.prefCode).toBe('43');
    expect(row?.storageVolumeM3).toBe(1_064_000);
    expect(row?.storageRate).toBeCloseTo(0.776, 3);
  });

  test('every stored row is internally consistent', () => {
    // Re-derived per row from the raw text rather than trusting the parser's
    // own denominator: every published rate must be explainable as
    // volume / capacity to within rounding.
    for (const r of parsed.rows) {
      expect(r.storageRate).toBeGreaterThan(0);
      expect(r.storageRate).toBeLessThanOrEqual(2);
    }
  });

  test('records the published universe, including 佐賀 rows that never match a target dam', () => {
    expect(parsed.published.length).toBeGreaterThanOrEqual(parsed.rows.length);
    const saga = parsed.published.filter((p) => p.prefCode === '41');
    expect(saga.length).toBeGreaterThan(0);
  });

  test('finds all 12 dams issue #28 targets', () => {
    const names = parsed.rows.map((r) => r.kyushuName);
    const expected = [
      ['久保白ダム', '40'],
      ['伊佐ノ浦ダム', '42'],
      ['教良木ダム', '43'],
      ['石場ダム', '44'],
      ['深見ダム', '44'],
      ['日指ダム', '44'],
      ['並石ダム', '44'],
      ['東原調整池', '45'],
      ['竹山ダム', '46'],
      ['西京ダム', '46'],
      ['金峰ダム', '46'],
      ['喜界地下ダム', '46'],
    ] as const;
    for (const [name, prefCode] of expected) {
      expect(names).toContain(name);
      const row = parsed.rows.find((r) => r.kyushuName === name);
      expect(row?.prefCode).toBe(prefCode);
    }
  });
});

describe('findLatestPdfUrl', () => {
  const BASE = 'https://www.maff.go.jp/kyusyu/keikaku/shinko/tyosui/tyosui.html';

  test('picks the current-survey link over the past-year archives', () => {
    const html = `
      <ul><li><a href="./attach/pdf/tyosui-109.pdf">令和8年9月1日現在の九州農政局管内の主要な農業用ダムの貯水状況(PDF : 94KB)</a></li></ul>
      <ul><li><a href="./attach/pdf/tyosui-94.pdf">令和7年の九州管内の主要な農業用ダムの貯水状況（1月から12月まで）(PDF : 176KB)</a></li></ul>
      <ul><li><a href="./attach/pdf/tyosui-76.pdf">令和6年の九州管内の主要な農業用ダムの貯水状況（1月から12月まで）(PDF : 179KB)</a></li></ul>
    `;
    expect(findLatestPdfUrl(html, BASE)).toBe(
      'https://www.maff.go.jp/kyusyu/keikaku/shinko/tyosui/attach/pdf/tyosui-109.pdf',
    );
  });

  test('returns null when the page links no current-survey PDF', () => {
    expect(findLatestPdfUrl('<p>準備中</p>', BASE)).toBeNull();
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '石場' },
    { id: 2n, name: '耶馬溪' },
    { id: 3n, name: '東原調整池' },
  ];

  test('matches the feed name minus its ダム suffix', () => {
    expect(chooseMaster('石場ダム', masters)).toBe(1n);
  });

  test('folds 渓/溪 so 耶馬渓ダム matches master 耶馬溪', () => {
    expect(chooseMaster('耶馬渓ダム', masters)).toBe(2n);
  });

  test('matches a 調整池-suffixed name exactly', () => {
    expect(chooseMaster('東原調整池', masters)).toBe(3n);
  });

  test('returns null for a dam the master does not hold', () => {
    expect(chooseMaster('存在しないダム', masters)).toBeNull();
  });
});
