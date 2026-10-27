// Fixture → universe entries for 大分県 農林水産部「農業用ダム貯水率一覧」(issue
// #27), no database: binding and writing belong to the ingest run.
//
// Runs against the real R8.9.8 survey PDF in tests/fixtures/oita_nourin, so
// this covers the unpdf extraction as well as the line parser — the layout is
// the risky half, and a hand-written text fixture would not exercise it.

import { describe, expect, test } from 'bun:test';
import type { Entry, Observed } from '../ingest/types.ts';
import {
  findLatestPdfUrl,
  oitaNourinEntries,
  parseOitaNourinDate,
  parseOitaNourinPdfText,
  pdfToText,
} from './ingest_oita_nourin.ts';

const FIXTURE = new URL('../../../../tests/fixtures/oita_nourin/r8_0908.pdf', import.meta.url)
  .pathname;

const text = await pdfToText(new Uint8Array(await Bun.file(FIXTURE).arrayBuffer()));
const entries = oitaNourinEntries(text);
const names = entries.map((e) => e.name);

const LIVE_INDEX = await Bun.file(
  new URL('../../../../tests/fixtures/oita_nourin/index_2026-09-28.html', import.meta.url).pathname,
).text();

function stateOf(e: Entry | undefined): string | undefined {
  const r = e?.reading;
  return r && typeof r !== 'function' ? r.state : undefined;
}

function observed(name: string): Observed | undefined {
  const r = entries.find((e) => e.name === name)?.reading;
  if (!r || typeof r === 'function' || r.state !== 'values') return undefined;
  return r.observations[0];
}

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

describe('oitaNourinEntries — the real R8.9.8 PDF', () => {
  test('dates every reading by the survey time in the PDF itself', () => {
    expect(parseOitaNourinPdfText(text).reportDate?.toISOString()).toBe('2026-09-08T00:00:00.000Z');
    expect(observed('石山ダム')?.observedAt.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });

  test('reads the dam rows', () => {
    // The survey covers 21 農業用ダム plus 国交省管理ダム listed for reference.
    expect(entries.filter((e) => stateOf(e) === 'values').length).toBeGreaterThanOrEqual(15);
    for (const e of entries) expect(e.pref).toBe('44');
  });

  test('reads 石山ダム with volume and rate in agreement', () => {
    // 788 千m³ 有効 / 183 千m³ 現 / 23.2 % — one of the 14 dams #27 adds.
    expect(observed('石山ダム')?.storageVolumeM3).toBe(183_000);
    expect(observed('石山ダム')?.storageRate).toBeCloseTo(0.232, 3);
  });

  test('reads a row whose 管理者 is typeset with spaces', () => {
    // 油留木ダム's manager prints as 「国 東 市」, which breaks a positional
    // column split — the parser anchors on the dam name instead. 150/165.
    expect(observed('油留木ダム')?.storageVolumeM3).toBe(150_000);
    expect(observed('油留木ダム')?.storageRate).toBeCloseTo(0.909, 3);
  });

  test('keeps the report title out of the universe', () => {
    // 「農業用ダムの貯水状況調査」 ends in ダム and matches NAME_RE, so it used
    // to enter the universe as a dam nobody publishes.
    expect(names).not.toContain('農業用ダム');
  });

  test('leaves rows whose printed rate is not 現貯水量 / 有効貯水量 unreadable', () => {
    // 大谷 (730/1,500 = 48.7 vs printed 89.0) and 大蘇 (3,095/3,890 = 79.6 vs
    // 72.0) are 国営 reservoirs rated against some other capacity. They are
    // published by the source, so they belong in the universe — but we must
    // not store a rate we cannot explain. This per-row identity is what
    // justifies trusted_rate_basis.
    expect(stateOf(entries.find((e) => e.name === '大谷ダム'))).toBe('unreadable');
    expect(stateOf(entries.find((e) => e.name === '大蘇ダム'))).toBe('unreadable');
  });

  test('excludes the 「(参考) 利水貯水量」 block of 国交省管理ダム', () => {
    // 耶馬渓 2,772/9,800 = 28.3 % is internally consistent, so the per-row
    // check cannot catch it — but that block's capacity column is 利水貯水量,
    // not the 有効貯水量 the main table prints, and storing it under
    // trusted_rate_basis would mean back-solving returns the wrong thing.
    expect(names).not.toContain('耶馬渓ダム');
    // The main table is untouched.
    expect(names).toContain('石山ダム');
  });

  test('names the dams #27 expects to add', () => {
    const all = names.join(' ');
    for (const n of ['石山', '鍋倉', '久木野尾', '乙見', '末広', '中ノ川', '石場', '大舞']) {
      expect(all).toContain(n);
    }
  });

  test('a PDF without its 現在 timestamp leaves every row unreadable, still listed', () => {
    const undated = oitaNourinEntries(text.replace(/現\s*在/g, ''));
    expect(undated).toHaveLength(entries.length);
    for (const e of undated) expect(stateOf(e)).toBe('unreadable');
  });
});

describe('binding', () => {
  const bind = (name: string) => entries.find((e) => e.name === name)?.bind;

  test('pins 大蘇ダム / 大谷ダム to their 熊本-filed NDI rows', () => {
    expect(bind('大蘇ダム')).toEqual({ ndi: '2306' });
    expect(bind('大谷ダム')).toEqual({ ndi: '2307' });
  });

  test('looks up 中ノ川ダム as the master 中の川', () => {
    expect(bind('中ノ川ダム')).toEqual({ name: '中の川' });
  });

  test('binds every other row by its own name within 大分', () => {
    expect(bind('石山ダム')).toBeUndefined();
  });
});

describe('findLatestPdfUrl', () => {
  const link = (id: string, label: string) =>
    `<p><a href="/uploaded/attachment/${id}.pdf">${label}</a></p>`;

  test('discovers the attachment link rather than pinning a filename', () => {
    const html = link('2276231', '令和8年9月8日現在の貯水率 [PDFファイル／63KB]');
    expect(findLatestPdfUrl(html)).toBe('https://www.pref.oita.jp/uploaded/attachment/2276231.pdf');
  });

  test('picks the newest survey, not the first link or the highest id', () => {
    // The page is free to list a 過去の調査 archive above the current survey,
    // and a re-uploaded old survey gets a fresh, higher CMS id. Either would
    // write an old survey under its own old timestamp, where nothing looks
    // wrong — the feed just stops moving.
    const html =
      link('2299999', '令和8年4月1日現在の貯水率') +
      link('2276594', '令和8年9月15日現在の貯水率') +
      link('2276231', '令和8年9月8日現在の貯水率');
    expect(findLatestPdfUrl(html)).toBe('https://www.pref.oita.jp/uploaded/attachment/2276594.pdf');
  });

  test('reads the date in the live index label, not the attachment id', () => {
    // The index as served on 2026-09-28 links 「令和8年9月24日現在の貯水率
    // [PDFファイル／62KB]」 (2277067). An older survey re-uploaded under a
    // higher id must not displace it.
    const html = `${LIVE_INDEX}${link('2299999', '令和8年4月1日現在の貯水率 [PDFファイル／60KB]')}`;
    expect(findLatestPdfUrl(html)).toBe('https://www.pref.oita.jp/uploaded/attachment/2277067.pdf');
  });

  test('falls back to the highest attachment id when no label carries a date', () => {
    // The CMS counter is monotonic, so a newer upload always outranks an older
    // one even if the link text is rewritten.
    const html = link('2276231', '貯水率一覧') + link('2276594', '最新') + link('2100000', '参考');
    expect(findLatestPdfUrl(html)).toBe('https://www.pref.oita.jp/uploaded/attachment/2276594.pdf');
  });

  test('still finds a bare path if the anchor markup changes shape', () => {
    expect(findLatestPdfUrl('<embed src="/uploaded/attachment/2276594.pdf">')).toBe(
      'https://www.pref.oita.jp/uploaded/attachment/2276594.pdf',
    );
  });

  test('returns null when the page links no PDF', () => {
    expect(findLatestPdfUrl('<p>準備中</p>')).toBeNull();
  });
});
