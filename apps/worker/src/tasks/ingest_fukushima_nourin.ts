// apps/worker/src/tasks/ingest_fukushima_nourin.ts
//
// 福島県 農林水産部「県内の主要農業関係ダムの貯水状況」— 農業用ダム 29 基。
//
// Source:
//   https://www.pref.fukushima.lg.jp/sec/36045d/noutikannri010.html
//
// Distinct from `fukushima-kasen` (土木部・河川): that feed carries the 11
// prefecture-managed river dams hourly, this one carries the *agricultural*
// dams — 溜池 / 調整池 / 土地改良区管理ダム — that never appear there.
//
// Format: one HTML table, columns
//   ダム名 | 所在市町村 | 管理受託者等 | 貯水率（かんがい用水） | 平年比 | 備考
// The survey date lives in an <h3>令和N年M月D日現在</h3> above the table.
// Values are percent strings; only 貯水率 is usable (no volume, no level).
//
// Cadence: roughly biweekly (survey dates, not a clock feed). Priority 285 —
// below jwa-junpo (290, 旬報) since this is coarser still, so any hourly
// source wins on a dam both cover. The rate is 利水(かんがい用水)基準 per the
// page's own footnote, so trusted_rate_basis is set (see migration 0040).

import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.FUKUSHIMA_NOURIN_URL ??
  'https://www.pref.fukushima.lg.jp/sec/36045d/noutikannri010.html';

const PREF_CODE = '07';
const SOURCE_ID = 'fukushima-nourin';

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

/**
 * Names the master spells differently: ノ/の (feed 山ノ入ダム, master 山の入),
 * and a 調整池 suffix the master omits (大深沢調整池 — 雄国山麓土地改良区 — is
 * master 大深沢, 東北農政局, 喜多方市; exact, so 大深沢 cannot take a longer name).
 */
const BINDS: Readonly<Record<string, Bind>> = {
  山ノ入ダム: { name: '山の入' },
  大深沢調整池: { name: '大深沢', exact: true },
};

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「令和N年M月D日現在」 → JST midnight of that day.
 * 令和 (Reiwa) year N → Gregorian 2018 + N.
 *
 * Anchored on 現在 so the CMS's own 掲載日 line — a day or two after the
 * survey — can never stand in for the survey date.
 */
export function parseNourinReportDate(html: string): Date | null {
  const m = html.match(/令和(\d+)年(\d+)月(\d+)日現在/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!mo || !day) return null;
  // JST midnight = 15:00 UTC the previous day.
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanCell(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function tableRows(html: string): string[][] {
  return Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) =>
      cleanCell(c[1] ?? ''),
    ),
  );
}

/** 「97.9%」 → 97.9. Prose cells ("調査対象外" 等) return null. */
function parsePercent(cell: string): number | null {
  const m = cell.match(/^(\d+(?:\.\d+)?)\s*[%％]$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Dam-like names only — excludes the 県平均 summary row and the footnote row. */
const NAME_RE = /(ダム|調整池|溜池|池|沼)$/;

/**
 * One row's 貯水率 cell. The page itself says there is none for 調査対象外
 * and for the annotated 0.0 % of a drained dam; a cell we cannot read may be
 * our parser rather than the page, so it is unreadable, not empty.
 */
function rowReading(cell: string, reportDate: Date | null): Reading {
  const pct = parsePercent(cell);
  // A published 0.0% here is never an operating value: the page annotates it
  // (鴻の巣ダム is drained for construction). Keeping it out keeps us out of
  // the phantom-zero hole migrations 0038/0039 had to dig us out of.
  if (pct === 0 || (pct === null && cell.includes('調査対象外'))) {
    return { state: 'empty', mark: cell };
  }
  if (pct === null || pct > MAX_PLAUSIBLE_PCT) {
    return { state: 'unreadable', why: `貯水率 cell 「${cell}」` };
  }
  if (!reportDate) return { state: 'unreadable', why: 'no 「…現在」 survey date on the page' };
  return { state: 'values', observations: [{ observedAt: reportDate, storageRate: pct / 100 }] };
}

/**
 * Every dam the page lists, whether or not its rate was usable: 鉄山 / 坂下
 * (調査対象外) and 鴻の巣 (落水) are published by 福島県, so /coverage must not
 * read them as published by nobody. The page gives no station ids, so the
 * printed name is the key.
 */
export function fukushimaNourinEntries(html: string): Entry[] {
  const reportDate = parseNourinReportDate(html);
  const entries: Entry[] = [];
  for (const cells of tableRows(html)) {
    if (cells.length < 4) continue;
    const name = cells[0] ?? '';
    if (!NAME_RE.test(name)) continue;
    const bind = BINDS[name];
    entries.push({
      key: name,
      name,
      pref: PREF_CODE,
      ...(bind ? { bind } : {}),
      reading: rowReading(cells[3] ?? '', reportDate),
    });
  }
  return entries;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} for ${PAGE_URL}`);
  const entries = fukushimaNourinEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} dam rows`);
  return { entries, dated: true };
});
