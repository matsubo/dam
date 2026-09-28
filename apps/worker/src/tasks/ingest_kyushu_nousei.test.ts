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
  masterFor,
  parseKyushuNouseiDate,
  parseKyushuNouseiPdfText,
  pdfToText,
} from './ingest_kyushu_nousei.ts';

const FIXTURE = new URL('../../../../tests/fixtures/kyushu_nousei/r8_0901.pdf', import.meta.url)
  .pathname;

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const parsed = parseKyushuNouseiPdfText(text);

const FIXTURE_0915 = new URL(
  '../../../../tests/fixtures/kyushu_nousei/r8_0915.pdf',
  import.meta.url,
).pathname;
const parsed0915 = parseKyushuNouseiPdfText(
  await pdfToText(new Uint8Array(await Bun.file(FIXTURE_0915).arrayBuffer())),
);

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

  test('parses 58 of the 59 published dams', () => {
    // The PDF lists 59 dams (matching the issue's own count). 58 carry a
    // usable R8.9.1 reading; 日向神ダム is the one exception — it genuinely
    // reports 0.0% that day (a multi-purpose flood-control dam mid-drawdown,
    // not a parser miss), which the phantom-zero guard correctly drops while
    // still recording it as published.
    expect(parsed.published.length).toBe(59);
    expect(parsed.rows.length).toBe(58);
    expect(parsed.published.some((p) => p.name === '日向神ダム')).toBe(true);
    expect(parsed.rows.some((r) => r.kyushuName === '日向神ダム')).toBe(false);
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

describe('parseKyushuNouseiPdfText — the R8.9.15 PDF (no leading 利水容量 column)', () => {
  // From R8.9.15 the table's date window starts at 4/15 and a row reads
  // 有効貯水量 → (貯水量, 貯水率)… with no 利水容量 column in between; the
  // R8.9.1 parser read the first volume as 利水容量 and kept 0 of 59 rows.
  const p = parsed0915;

  test('dates the survey 令和8年9月15日', () => {
    expect(p.reportDate?.toISOString()).toBe('2026-09-14T15:00:00.000Z');
  });

  test('keeps the same 58 of 59 rows as the old layout', () => {
    expect(p.published.length).toBe(59);
    expect(p.rows.length).toBe(58);
  });

  test('reads the 9/15 column: 石場 886 千m³ 41.1 %, 花宗ため池 1,499 千m³ 58.1 %', () => {
    const row = (name: string) => p.rows.find((r) => r.kyushuName === name);
    expect(row('石場ダム')?.storageVolumeM3).toBe(886_000);
    expect(row('石場ダム')?.storageRate).toBeCloseTo(0.411, 3);
    expect(row('花宗ため池')?.storageVolumeM3).toBe(1_499_000);
  });

  test('keeps a row whose first survey column is a 「－ －」 missing pair', () => {
    // 教良木ダム printed 「－ －」 for 8/1; once the window reaches that column
    // it is the first pair after 有効貯水量, where no 利水容量 column precedes it.
    const p2 = parseKyushuNouseiPdfText(
      '熊本 教良木川 教良木ダム 1,371 - - 1,153 84.1% 1,064 77.6% 1,200 87.5% 90.0%',
    );
    expect(p2.published).toEqual([{ name: '教良木ダム', prefCode: '43' }]);
    expect(p2.rows).toHaveLength(1);
    expect(p2.rows[0]?.storageVolumeM3).toBe(1_064_000);
    expect(p2.rows[0]?.storageRate).toBeCloseTo(0.776, 3);
  });

  test('checks a multi-purpose dam against its reprinted 利水容量, not 有効貯水量', () => {
    // 寺内ダム 有効 16,000 / 利水 8,230: 1,937 / 8,230 = 23.5 %.
    const r = p.rows.find((x) => x.kyushuName === '寺内ダム');
    expect(r?.storageVolumeM3).toBe(1_937_000);
    expect(r?.storageRate).toBeCloseTo(0.235, 3);
  });

  test('stamps each prefecture block at the hour its figures were read', () => {
    // The PDF prints no hour. Against prod's hourly feeds over the 11 survey
    // columns (4/15–9/15), 福岡's figures are the JST-midnight readings
    // (江川 4,652 = fukuoka-bodik 09-14T15:00Z) while 佐賀/熊本/大分/宮崎 are
    // the 09:00 JST ones (厳木 3,553 = kasenbosai 09-15T00:00Z, 市房 4,371 =
    // kumamoto-bousai 00:00Z, 石場 886 = oita-nourin's 「9：00現在」 row).
    const at = (name: string) =>
      p.rows.find((r) => r.kyushuName === name)?.observedAt.toISOString();
    expect(at('江川ダム')).toBe('2026-09-14T15:00:00.000Z');
    expect(at('厳木ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('市房ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('石場ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('綾北ダム')).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('chooseMaster', () => {
  const masters = [
    { id: 1n, name: '石場' },
    { id: 2n, name: '耶馬溪' },
    { id: 3n, name: '東原調整池' },
    { id: 4n, name: '花宗溜池' },
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

  test('folds ため池/溜池 so 花宗ため池 matches master 花宗溜池', () => {
    expect(chooseMaster('花宗ため池', masters)).toBe(4n);
  });

  test('returns null for a dam the master does not hold', () => {
    expect(chooseMaster('存在しないダム', masters)).toBeNull();
  });
});

describe('masterFor', () => {
  // The master files 大蘇 and 大谷 under 熊本; the PDF prints them under 大分.
  const mastersByPref = new Map([
    [
      '43',
      [
        { id: 10n, name: '大蘇' },
        { id: 11n, name: '大谷' },
      ],
    ],
    ['44', [{ id: 1n, name: '石場' }]],
    ['40', [{ id: 20n, name: '大谷' }]],
  ]);
  const pinnedIds = new Map([
    ['2306', 10n],
    ['2307', 11n],
  ]);
  const bind = (name: string) => {
    const r = parsed0915.rows.find((x) => x.kyushuName === name);
    return r ? masterFor(r.kyushuName, r.prefCode, mastersByPref, pinnedIds) : undefined;
  };

  test('binds the 大分-printed 大蘇ダム / 大谷ダム to their 熊本-filed NDI rows', () => {
    expect(bind('大蘇ダム')).toBe(10n);
    expect(bind('大谷ダム')).toBe(11n);
  });

  test('matches every other row by name within its own prefecture', () => {
    expect(bind('石場ダム')).toBe(1n);
    expect(masterFor('大谷ダム', '40', mastersByPref, pinnedIds)).toBe(20n);
  });
});
