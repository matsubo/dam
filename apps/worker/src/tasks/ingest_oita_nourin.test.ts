// Parser tests for 大分県 農林水産部「農業用ダム貯水率一覧」(issue #27).
//
// Runs against the real R8.9.8 survey PDF in tests/fixtures/oita_nourin, so
// this covers the unpdf extraction as well as the line parser — the layout is
// the risky half, and a hand-written text fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import {
  chooseMaster,
  findLatestPdfUrl,
  parseOitaNourinDate,
  parseOitaNourinPdfText,
  pdfToText,
} from './ingest_oita_nourin.ts';

const FIXTURE = new URL('../../../../tests/fixtures/oita_nourin/r8_0908.pdf', import.meta.url)
  .pathname;

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const parsed = parseOitaNourinPdfText(text);

describe('parseOitaNourinDate', () => {
  test('reads the full-width 令和 survey timestamp as JST', () => {
    // （ 令和８年９月８日 ９：００ 現在 ） → 2026-09-08 09:00 JST → 00:00Z.
    const d = parseOitaNourinDate('（ 令和８年９月８日 ９：００ 現在 ）');
    expect(d?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  test('accepts half-width digits too', () => {
    const d = parseOitaNourinDate('令和8年9月8日 9:00 現在');
    expect(d?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  test('returns null without a 現在 anchor', () => {
    expect(parseOitaNourinDate('令和8年9月8日 掲載')).toBeNull();
  });
});

describe('parseOitaNourinPdfText — the real R8.9.8 PDF', () => {
  test('extracts the survey date from the PDF itself', () => {
    expect(parsed.reportDate?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  test('parses the dam rows', () => {
    // The survey covers 21 農業用ダム plus 国交省管理ダム listed for reference.
    expect(parsed.rows.length).toBeGreaterThanOrEqual(15);
  });

  test('reads 石山ダム with volume and rate in agreement', () => {
    // 788 千m³ 有効 / 183 千m³ 現 / 23.2 % — one of the 14 dams #27 adds.
    const row = parsed.rows.find((r) => r.oitaName === '石山ダム');
    expect(row).toBeDefined();
    expect(row?.effectiveCapacityM3).toBe(788_000);
    expect(row?.storageVolumeM3).toBe(183_000);
    expect(row?.storageRate).toBeCloseTo(0.232, 3);
  });

  test('reads a row whose 管理者 is typeset with spaces', () => {
    // 油留木ダム's manager prints as 「国 東 市」, which breaks a positional
    // column split — the parser anchors on the dam name instead.
    const row = parsed.rows.find((r) => r.oitaName === '油留木ダム');
    expect(row?.effectiveCapacityM3).toBe(165_000);
    expect(row?.storageVolumeM3).toBe(150_000);
    expect(row?.storageRate).toBeCloseTo(0.909, 3);
  });

  test('every stored row is internally consistent', () => {
    // The published 貯水率 must equal 現貯水量 / 有効貯水量. This is what
    // justifies trusted_rate_basis: back-solving returns the source's own
    // 有効貯水量, which for most of these dams the master does not hold.
    for (const r of parsed.rows) {
      const implied = r.storageVolumeM3 / r.effectiveCapacityM3;
      expect(Math.abs(implied - r.storageRate)).toBeLessThan(0.015);
    }
  });

  test('records the published universe, including rows without a usable rate', () => {
    expect(parsed.published.length).toBeGreaterThanOrEqual(parsed.rows.length);
    expect(parsed.published).toContain('石山ダム');
  });

  test('keeps the report title out of the published universe', () => {
    // 「農業用ダムの貯水状況調査」 ends in ダム and matches NAME_RE, so it used
    // to enter the universe as a dam nobody publishes.
    expect(parsed.published).not.toContain('農業用ダム');
    for (const n of parsed.published) expect(n).not.toBe('農業用ダム');
  });

  test('drops rows whose printed rate is not 現貯水量 / 有効貯水量', () => {
    // 大谷 (730/1,500 = 48.7 vs printed 89.0) and 大蘇 (3,095/3,890 = 79.6 vs
    // 72.0) are 国営 reservoirs rated against some other capacity. They are
    // published by the source, so they belong in the universe — but we must
    // not store a rate we cannot explain.
    expect(parsed.published).toContain('大谷ダム');
    expect(parsed.published).toContain('大蘇ダム');
    expect(parsed.rows.find((r) => r.oitaName === '大谷ダム')).toBeUndefined();
    expect(parsed.rows.find((r) => r.oitaName === '大蘇ダム')).toBeUndefined();
  });

  test('names the dams #27 expects to add', () => {
    const names = parsed.published.join(' ');
    for (const n of ['石山', '鍋倉', '久木野尾', '乙見', '末広', '中ノ川', '石場', '大舞']) {
      expect(names).toContain(n);
    }
  });
});

describe('findLatestPdfUrl', () => {
  test('discovers the attachment link rather than pinning a filename', () => {
    const html = '<p><a href="/uploaded/attachment/2276231.pdf">R8.9.8</a></p>';
    expect(findLatestPdfUrl(html)).toBe('https://www.pref.oita.jp/uploaded/attachment/2276231.pdf');
  });

  test('returns null when the page links no PDF', () => {
    expect(findLatestPdfUrl('<p>準備中</p>')).toBeNull();
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '石山' },
    { id: 2n, name: '久木野尾' },
    { id: 3n, name: '大蘇' },
  ];

  test('matches the feed name minus its ダム suffix', () => {
    expect(chooseMaster('石山ダム', masters)).toBe(1n);
    expect(chooseMaster('久木野尾ダム', masters)).toBe(2n);
  });

  test('returns null for a dam the master does not hold', () => {
    expect(chooseMaster('存在しないダム', masters)).toBeNull();
  });

  test('folds the 渓/溪 kanji variant', () => {
    // The feed prints 耶馬渓, the master holds 耶馬溪 — the same dam in new and
    // old kanji.
    expect(chooseMaster('耶馬渓ダム', [{ id: 9n, name: '耶馬溪' }])).toBe(9n);
  });
});
