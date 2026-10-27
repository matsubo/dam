// apps/worker/src/tasks/ingest_dainichigawa_lid.ts
//
// 大日川土地改良区「大日川ダム情報」 — 大日川ダム (南あわじ市賀集生子, 三原川水系,
// 兵庫/28), a 兵庫県 irrigation dam no other feed publishes.
//
// Source: http://dainichigawa-lid.com/dam.html. The page shows the latest
// reading (「令和８年９月２８日９時更新」) and links one PDF per month of the
// fiscal year, newest first:
//   <a href="pdfs/R8sepday-dam.pdf">令和８年９月　日別ダム情報</a>
// Each PDF is one table, 「各日午前９時測定」, one line per day once unpdf
// extracts it:
//   9月28日 28.25 174.65 91.2 0.00
//   = 日付 水位(ｍ) 貯水量(万ｔ) 貯水率(％) 貯水量前日比(万ｔ) [備考 降水量…]
// Days not yet measured are printed with no figures. The PDF carries no year,
// so the year and month come from the link text, and a row of another month
// is refused rather than stamped into the wrong one. Rows are stamped 09:00
// JST. Weekend rows appear with Monday's upload (the 9/27 Sunday row was in
// the file modified Mon 08:33 JST), so every run re-reads the current and the
// previous month.
//
// Stored: 貯水量 (万t of water, i.e. ×10⁴ m³) and 貯水率. Not stored: 水位 is a
// depth gauge (28.25 m against 「最大水位29.4ｍ」; the 概要 page puts 常時満水位
// at EL.159.00 m), not an elevation, the same call mc-tottori-hydro makes.
//
// Rate: 貯水量 ÷ the 「最大貯水量191.5万ｔ」 printed on every PDF and page
// (174.65 / 191.5 = 91.2 %), not the master's 2,032 千m³ 有効貯水容量, which
// would show 85.9 %. 0213 marks the source trusted_rate_basis so the site
// shows the district's own figure (0098's reasoning for sasebo-suido 川谷).
//
// Binding: two masters are named 大日川 — NDI 1594 (兵庫県, 南あわじ市, the
// 概要 page's 位置「兵庫県南あわじ市賀集生子」) and NDI 1242 (石川, 北陸農政局).
// The pref filter already separates them; the NDI pin keeps a future 兵庫
// namesake from being picked by name.
//
// Licence: the site states no terms; its footer reads 「© 2023 大日川土地改良区
// -Dainichigawa Land Improvement District-」. robots.txt is 404.
//
// Priority 278: nothing else publishes 大日川. Cron daily 03:33 UTC (12:33 JST).

import { extractText, getDocumentProxy } from 'unpdf';
import { ingestTask, type Log } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import { type Upstream, UpstreamError } from '../ingest/upstream.ts';

const PAGE_URL = process.env.DAINICHIGAWA_LID_URL ?? 'http://dainichigawa-lid.com/dam.html';

const SOURCE_ID = 'dainichigawa-lid';
const PREF_CODE = '28';
/** The page publishes one dam and no station code; its name is the key. */
const STATION = '大日川ダム';
const NDI = '1594';
/** The current month plus the previous one, for rows uploaded late. */
const MONTHS_PER_RUN = 2;

// --- parsing ----------------------------------------------------------------

export interface DailyLink {
  url: string;
  year: number;
  month: number;
}

/** The monthly 日別ダム情報 PDFs, in page order (newest first). */
export function parseDailyLinks(html: string, pageUrl: string): DailyLink[] {
  const links: DailyLink[] = [];
  for (const a of html.matchAll(/<a[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = (a[2] ?? '').replace(/<[^>]*>/g, '').normalize('NFKC');
    const ym = label.match(/令和(元|\d+)年(\d{1,2})月\s*日別ダム情報/);
    if (!a[1] || !ym) continue;
    links.push({
      url: new URL(a[1], pageUrl).href,
      year: 2018 + (ym[1] === '元' ? 1 : Number(ym[1])),
      month: Number(ym[2]),
    });
  }
  return links;
}

export interface DailyReading {
  observedAt: Date;
  storageVolumeM3: number;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

/** One reading per measured day of `month`; blank days and other months are dropped. */
export function parseDailyText(text: string, year: number, month: number): DailyReading[] {
  const rows: DailyReading[] = [];
  for (const line of text.normalize('NFKC').split('\n')) {
    const m = line.match(
      /^\s*(\d{1,2})月(\d{1,2})日\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)(?:\s|$)/,
    );
    if (!m || Number(m[1]) !== month) continue;
    rows.push({
      // 午前9時 JST = 00:00 UTC the same day.
      observedAt: new Date(Date.UTC(year, month - 1, Number(m[2]))),
      storageVolumeM3: Math.round(Number(m[3]) * 10_000),
      storageRate: Number(m[4]) / 100,
    });
  }
  return rows;
}

/** Extract the PDF's text with unpdf (no poppler in the runtime image). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/** Every measured day of the months read; none is unreadable. */
export function dailyReading(rows: DailyReading[]): Reading {
  return rows.length > 0
    ? { state: 'values', observations: rows }
    : { state: 'unreadable', why: 'no measured day in the monthly PDFs' };
}

// --- entries ----------------------------------------------------------------

/** The page and its newest monthly PDFs, read into one reading. */
async function readDam(upstream: Upstream, log: Log): Promise<Reading> {
  const page = await upstream.fetch(PAGE_URL);
  const links = parseDailyLinks(page.text(), PAGE_URL).slice(0, MONTHS_PER_RUN);
  if (links.length === 0) throw new Error(`no monthly PDF linked from ${PAGE_URL}`);

  const rows: DailyReading[] = [];
  for (const link of links) {
    let bytes: Uint8Array;
    try {
      bytes = (await upstream.fetch(link.url, { timeoutMs: 30_000 })).bytes;
    } catch (err) {
      // A month the server answers with an error status is skipped; a network
      // failure still fails the reading.
      if (!(err instanceof UpstreamError) || err.status === null) throw err;
      log(`${err.message}; skipped`);
      continue;
    }
    rows.push(...parseDailyText(await pdfToText(bytes), link.year, link.month));
  }
  return dailyReading(rows);
}

/**
 * The one dam the district publishes, whether or not this run's page loads:
 * a failed fetch leaves it unreadable, never unrecorded, so /coverage can
 * tell "published, not linked" from "nobody publishes it". Pinned to NDI 1594.
 */
export function dainichigawaEntry(upstream: Upstream, log: Log): Entry {
  return {
    key: STATION,
    name: STATION,
    pref: PREF_CODE,
    bind: { ndi: NDI },
    reading: () => readDam(upstream, log),
  };
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => ({
  entries: [dainichigawaEntry(upstream, log)],
}));
