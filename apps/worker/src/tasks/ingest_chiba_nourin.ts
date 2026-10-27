// apps/worker/src/tasks/ingest_chiba_nourin.ts
//
// 千葉県 農林水産部 耕地課「千葉県内農業用ダム貯水状況」— 農業用ダム 11 基。
//
// Source:
//   https://www.pref.chiba.lg.jp/kouchi/nougyou-dam.html
//
// 10 of the 11 have never been live: only 保台 is covered today, by
// 千葉県水政課. Checked dam by dam against production before building this —
// 金山 and the rest report 「まだ観測値がありません」. See #29, where ranking
// candidates by how many dams a page lists (rather than by net-new) put 栃木
// second on the shortlist when it would have added nothing at all.
//
// Format: one HTML table, columns
//   施設名 | ダム有効貯水量(m³) | 現有効貯水量(m³) | 貯水率(%)
// Volumes are already in m³ here — unlike 大分 and 九州, which print 千m³ — so
// there is no unit conversion, and a stray one would be a factor of a thousand.
// The final 計 row is a total, not a dam.
//
// The survey time lives in a heading: 「県内農業用ダムの貯水状況（令和8年9月14日
// 09時現在）」. Note 09時, not 9:00 — the 大分 parser's format does not fit.
//
// Cadence: the page's 更新日 ran three days behind the survey when this was
// written, so it is polled daily and written on the survey timestamp, the same
// shape as fukushima-nourin and oita-nourin.
//
// Priority 284 — between fukushima-nourin (285) and oita-nourin (282); any
// hourly feed still wins a dam this also covers, which today means 保台.
//
// trusted_rate_basis is set: the printed 貯水率 is 現有効貯水量 / ダム有効貯水量
// from the same row (金山 1,550,000/1,727,000 = 89.8, 勝浦 1,193,000/1,850,000
// = 64.5), so back-solving returns the source's own 有効貯水量. The per-row
// check below enforces that rather than trusting the claim wholesale.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.CHIBA_NOURIN_URL ?? 'https://www.pref.chiba.lg.jp/kouchi/nougyou-dam.html';

const PREF_CODE = '12';
const SOURCE_ID = 'chiba-nourin';

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「（令和8年9月14日09時現在）」 → that instant in JST.
 *
 * Anchored on 現在 so the page's 更新日 — which ran three days later than the
 * survey when this was written — can never stand in for the survey time. The
 * hour is optional: a heading that omits it means midnight JST.
 */
export function parseChibaNourinDate(html: string): Date | null {
  const m = html.match(/令和(\d+)年\s*(\d+)月\s*(\d+)日\s*(?:(\d+)\s*時)?\s*現在/);
  if (!m) return null;
  const era = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const hh = m[4] === undefined ? 0 : Number(m[4]);
  if (!mo || !day) return null;
  // 令和 N → 2018 + N. JST is UTC+9.
  const d = new Date(Date.UTC(2018 + era, mo - 1, day, hh - 9, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanCell(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(html: string): string[][] {
  return Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) =>
      cleanCell(c[1] ?? ''),
    ),
  );
}

/** 「1,727,000」→ 1727000. Prose or an em-dash returns null. */
function parseNum(s: string): number | null {
  const t = s.replace(/,/g, '').trim();
  if (!t || !/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Dam-like names only. Excludes the 計 total row and any header cell. */
const NAME_RE = /(ダム|調整池|貯水池|溜池|ため池|池|沼)$/;

/** A cell the page prints in place of a figure. */
const MARK_RE = /^[－―ー‐—-]+$/;

/** One dam row: 施設名 and the three figure cells as printed. */
function rowReading(cells: string[], reportDate: Date | null): Reading {
  const figures = cells.slice(1, 4);
  if (figures.every((c) => MARK_RE.test(c))) return { state: 'empty', mark: figures.join(' ') };
  const capacity = parseNum(cells[1] ?? '');
  const volume = parseNum(cells[2] ?? '');
  const pct = parseNum(cells[3] ?? '');
  if (capacity == null || volume == null || pct == null || capacity <= 0) {
    return { state: 'unreadable', why: `cells 「${figures.join('」「')}」` };
  }
  // A published 0 % on an agricultural reservoir is drained or out of survey,
  // not an operating reading; storing it would recreate the phantom zeros
  // migrations 0038/0039 had to undo.
  if (pct <= 0 || pct > MAX_PLAUSIBLE_PCT) {
    return { state: 'unreadable', why: `貯水率 ${pct} % is not an operating reading` };
  }
  // The row must be internally consistent: the printed rate is
  // 現有効貯水量 / ダム有効貯水量. A row that fails this is a column misread or
  // a second denominator — unreadable rather than a number we cannot
  // explain. The tolerance is in percentage points.
  const implied = (100 * volume) / capacity;
  if (Math.abs(implied - pct) > 1.5) {
    return { state: 'unreadable', why: `printed ${pct} % is not ${volume}/${capacity}` };
  }
  if (!reportDate) return { state: 'unreadable', why: 'no 「…現在」 survey date on the page' };
  return {
    state: 'values',
    observations: [{ observedAt: reportDate, storageVolumeM3: volume, storageRate: pct / 100 }],
  };
}

/** Every dam the page lists, in table order. */
export function chibaNourinEntries(html: string): Entry[] {
  const reportDate = parseChibaNourinDate(html);
  const entries: Entry[] = [];
  for (const cells of tableRows(html)) {
    if (cells.length < 4) continue;
    const name = cells[0] ?? '';
    // 「計」 carries the same three numeric columns as a dam row, so it has to be
    // excluded by name — a numeric-shape check would let it through and invent
    // a 22,816,000 m³ reservoir.
    if (!NAME_RE.test(name)) continue;
    entries.push({ key: name, name, pref: PREF_CODE, reading: rowReading(cells, reportDate) });
  }
  return entries;
}

// A parser that silently yields nothing is the failure mode a table scraper is
// most exposed to — a column reorder or a markup change makes every row
// unreadable while the fetch still succeeds, and the run then fails the job.
// Exiting green there is how #31 stayed hidden.
export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = chibaNourinEntries((await upstream.fetch(PAGE_URL)).text());
  log(`${SOURCE_ID}: ${entries.length} dam rows`);
  return { entries, dated: true };
});
