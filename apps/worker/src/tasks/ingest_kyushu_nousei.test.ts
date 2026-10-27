// Fixture → universe entries for 九州農政局「管内の農業用ダムの貯水状況」(issue
// #28), no database: binding and writing belong to the ingest run.
//
// Runs against the real R8.9.1 survey PDF in tests/fixtures/kyushu_nousei, so
// this covers the unpdf extraction as well as the row/column parser — the
// wide seasonal-capacity table is the risky half, and a hand-written text
// fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  findLatestPdfUrl,
  kyushuNouseiEntries,
  parseKyushuNouseiDate,
  parseKyushuNouseiPdfText,
  pdfToText,
} from './ingest_kyushu_nousei.ts';

const FIXTURE = new URL('../../../../tests/fixtures/kyushu_nousei/r8_0901.pdf', import.meta.url)
  .pathname;

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const parsed = parseKyushuNouseiPdfText(text);
const entries = kyushuNouseiEntries(text);

const FIXTURE_0915 = new URL(
  '../../../../tests/fixtures/kyushu_nousei/r8_0915.pdf',
  import.meta.url,
).pathname;
const text0915 = await pdfToText(new Uint8Array(await Bun.file(FIXTURE_0915).arrayBuffer()));
const entries0915 = kyushuNouseiEntries(text0915);

function stateOf(e: Entry | undefined): string | undefined {
  const r = e?.reading;
  return r && typeof r !== 'function' ? r.state : undefined;
}

function observed(list: Entry[], name: string): Observed | undefined {
  const r = list.find((e) => e.name === name)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') return undefined;
  return r.observations[0];
}

const valued = (list: Entry[]) => list.filter((e) => stateOf(e) === 'values');

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

describe('kyushuNouseiEntries — the real R8.9.1 PDF', () => {
  test('extracts the survey date from the PDF itself', () => {
    expect(parsed.reportDate?.toISOString()).toBe('2026-08-31T15:00:00.000Z');
  });

  test('lists all 59 dams; 58 carry the R8.9.1 reading', () => {
    // The PDF lists 59 dams (matching the issue's own count). 日向神ダム is the
    // one exception — it genuinely reports 0.0% that day (a multi-purpose
    // flood-control dam mid-drawdown, not a parser miss), which the
    // phantom-zero guard leaves unreadable while still listing it.
    expect(entries).toHaveLength(59);
    expect(valued(entries)).toHaveLength(58);
    expect(stateOf(entries.find((e) => e.name === '日向神ダム'))).toBe('unreadable');
  });

  test('reads 石場ダム (shared with oita-nourin, #27) with the R8.9.1 value', () => {
    // 大分 大野川 石場ダム: 2,154 千m³ 有効/利水 (same figure), 688 千m³ 現,
    // 31.9% — the fixture's own footer confirms this after the mid-row
    // capacity-update markers around the 洪水期 boundary are skipped.
    expect(entries.find((e) => e.name === '石場ダム')?.pref).toBe('44');
    const o = observed(entries, '石場ダム');
    expect(o?.storageVolumeM3).toBe(688_000);
    expect(o?.storageRate).toBeCloseTo(0.319, 3);
  });

  test('reads a row across a prefecture boundary where 県名 is not repeated', () => {
    // 伊佐ノ浦ダム (長崎) is not the first row of its block's block-mate 繁敷
    // ダム, but 小ヶ倉ダム above it is — 県名 must carry forward correctly.
    expect(entries.find((e) => e.name === '伊佐ノ浦ダム')?.pref).toBe('42');
    const o = observed(entries, '伊佐ノ浦ダム');
    expect(o?.storageVolumeM3).toBe(1_459_000);
    expect(o?.storageRate).toBeCloseTo(0.89, 2);
  });

  test('reads a row with a missing mid-year survey date (熊本 教良木ダム)', () => {
    // The PDF's own footnote says 教良木ダム's R8.8.1 column is blank
    // ("－ －"); pairDateColumns must still land on the correct R8.9.1 pair
    // afterwards rather than shifting off by one.
    expect(entries.find((e) => e.name === '教良木ダム')?.pref).toBe('43');
    const o = observed(entries, '教良木ダム');
    expect(o?.storageVolumeM3).toBe(1_064_000);
    expect(o?.storageRate).toBeCloseTo(0.776, 3);
  });

  test('every stored rate is a plausible fraction', () => {
    for (const e of valued(entries)) {
      const rate = observed(entries, e.name)?.storageRate ?? 0;
      expect(rate).toBeGreaterThan(0);
      expect(rate).toBeLessThanOrEqual(2);
    }
  });

  test('keys rows by prefecture, 佐賀 included', () => {
    expect(entries.filter((e) => e.pref === '41').length).toBeGreaterThan(0);
    expect(entries.find((e) => e.name === '石場ダム')?.key).toBe('44:石場ダム');
  });

  test('finds all 12 dams issue #28 targets', () => {
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
      const e = valued(entries).find((x) => x.name === name);
      expect(e?.pref).toBe(prefCode);
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

describe('kyushuNouseiEntries — the R8.9.15 PDF (no leading 利水容量 column)', () => {
  // From R8.9.15 the table's date window starts at 4/15 and a row reads
  // 有効貯水量 → (貯水量, 貯水率)… with no 利水容量 column in between; the
  // R8.9.1 parser read the first volume as 利水容量 and kept 0 of 59 rows.
  const p = entries0915;
  const TITLE = '九州農政局管内の合計貯水率（令和８年９月１５日現在）';

  test('dates the survey 令和8年9月15日', () => {
    expect(parseKyushuNouseiPdfText(text0915).reportDate?.toISOString()).toBe(
      '2026-09-14T15:00:00.000Z',
    );
  });

  test('keeps the same 58 of 59 rows as the old layout', () => {
    expect(p).toHaveLength(59);
    expect(valued(p)).toHaveLength(58);
  });

  test('reads the 9/15 column: 石場 886 千m³ 41.1 %, 花宗ため池 1,499 千m³ 58.1 %', () => {
    expect(observed(p, '石場ダム')?.storageVolumeM3).toBe(886_000);
    expect(observed(p, '石場ダム')?.storageRate).toBeCloseTo(0.411, 3);
    expect(observed(p, '花宗ため池')?.storageVolumeM3).toBe(1_499_000);
  });

  test('keeps a row whose first survey column is a 「－ －」 missing pair', () => {
    // 教良木ダム printed 「－ －」 for 8/1; once the window reaches that column
    // it is the first pair after 有効貯水量, where no 利水容量 column precedes it.
    const p2 = kyushuNouseiEntries(
      `${TITLE}\n熊本 教良木川 教良木ダム 1,371 - - 1,153 84.1% 1,064 77.6% 1,200 87.5% 90.0%`,
    );
    expect(p2.map((e) => [e.key, e.pref])).toEqual([['43:教良木ダム', '43']]);
    const r = p2[0]?.reading;
    if (!r || typeof r === 'function' || r.state !== 'values') throw new Error('no values');
    expect(r.observations[0]?.storageVolumeM3).toBe(1_064_000);
    expect(r.observations[0]?.storageRate).toBeCloseTo(0.776, 3);
  });

  test('a current survey printed 「－ －」 is the PDF’s own mark: provider-marked empty', () => {
    const p2 = kyushuNouseiEntries(
      `${TITLE}\n熊本 教良木川 教良木ダム 1,371 1,153 84.1% - - 1,200 87.5% 90.0%`,
    );
    expect(stateOf(p2[0])).toBe('empty');
  });

  test('checks a multi-purpose dam against its reprinted 利水容量, not 有効貯水量', () => {
    // 寺内ダム 有効 16,000 / 利水 8,230: 1,937 / 8,230 = 23.5 %.
    expect(observed(p, '寺内ダム')?.storageVolumeM3).toBe(1_937_000);
    expect(observed(p, '寺内ダム')?.storageRate).toBeCloseTo(0.235, 3);
  });

  test('stamps each prefecture block at the hour its figures were read', () => {
    // The PDF prints no hour. Against prod's hourly feeds over the 11 survey
    // columns (4/15–9/15), 福岡's figures are the JST-midnight readings
    // (江川 4,652 = fukuoka-bodik 09-14T15:00Z) while 佐賀/熊本/大分/宮崎 are
    // the 09:00 JST ones (厳木 3,553 = kasenbosai 09-15T00:00Z, 市房 4,371 =
    // kumamoto-bousai 00:00Z, 石場 886 = oita-nourin's 「9：00現在」 row).
    // 鹿児島 is midnight too: 高隈's 6/1–9/15 volumes against kasenbosai's
    // 貯水位 give ΔV/ΔL 924–967 千m³/m at midnight, 901–1,335 at 09:00.
    const at = (name: string) => observed(p, name)?.observedAt.toISOString();
    expect(at('江川ダム')).toBe('2026-09-14T15:00:00.000Z');
    expect(at('高隈ダム')).toBe('2026-09-14T15:00:00.000Z');
    expect(at('厳木ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('市房ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('石場ダム')).toBe('2026-09-15T00:00:00.000Z');
    expect(at('綾北ダム')).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('binding', () => {
  const bind = (key: string) => entries0915.find((e) => e.key === key)?.bind;

  test('pins the 大分-printed 大蘇ダム / 大谷ダム to their 熊本-filed NDI rows', () => {
    expect(bind('44:大蘇ダム')).toEqual({ ndi: '2306' });
    expect(bind('44:大谷ダム')).toEqual({ ndi: '2307' });
  });

  test('pins 小ヶ倉ダム to NDI 2592 of its two same-named master rows', () => {
    expect(bind('42:小ヶ倉ダム')).toEqual({ ndi: '2592' });
  });

  test('looks up the master spelling of 花宗ため池 and 耶馬渓ダム', () => {
    expect(bind('40:花宗ため池')).toEqual({ name: '花宗溜池' });
    expect(bind('44:耶馬渓ダム')).toEqual({ name: '耶馬溪ダム' });
  });

  test('binds every other row by its own name within its own prefecture', () => {
    expect(bind('44:石場ダム')).toBeUndefined();
  });
});
