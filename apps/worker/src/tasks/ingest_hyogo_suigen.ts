// apps/worker/src/tasks/ingest_hyogo_suigen.ts
//
// 兵庫県 企画部 総合政策課「県内の水源の状況」 — 県内主要水源の貯水率, monthly.
//
// Source: https://web.pref.hyogo.lg.jp/kk05/ac07_000000162.html. Static UTF-8
// HTML, one table.datatable captioned 【令和8年9月1日現在】, columns
//   ダム名 | 所在地 | 用途 | 貯水率 | 貯水率（10か年平均）
// The page says 「通常時は月1回程度、渇水が予測される場合は頻度を高めて」: the
// survey is the 1st of the month (published ~10 days later) and in a 渇水 the
// table grows (2025-08: 大路/但東/三宝/栗柄 added, 呑吐 and 大川瀬 split, and a
// 取水制限 notice table above it). The date carries no time, so a survey is
// stamped 00:00 JST; the daily poll re-writes the same row until it changes.
//
// Rate only (integer %); no volume or level is published. The rates are the
// managers' own, not volume ÷ ダム便覧 有効: on 2026-09-01 the page's 一庫 100 %
// equals jwa-junpo's native 1.0000 at 00:00 JST while 14,004 千m³ is 45.5 % of
// 有効 30,800; 青野 prints 89 % against 58.4 % of 有効. 淡路広域水道企業団's
// own table (awaji-suido.jp/osirase-01.html, 2024–2026) back-solves the 淡路
// dams: 猪鼻第2 479,200 / 100 % = 479 千m³ (master 有効 479), 猪鼻第1 311,300 /
// 100.1 % = 311 (master 304), 竹原 525,200 / 100.7 % = 522 against master 618 —
// a full 竹原 reads 100 % here. The rate is kept anyway: it is the manager's
// fullness of the dam's whole 水道 pool, not one user's share. With no volume
// there is nothing for trusted_rate_basis to back-solve, so the source stays
// untrusted (0048).
//
// Written: 千苅/丸山/加古川大堰, which have no other feed, and 鴨川 (plus 呑吐,
// 大川瀬 and 但東 when a 渇水 layout lists them apart), whose only feeds carry
// the level and no storage (kasenbosai, hyogo-bodik; prod 2026-09-28). Rows
// whose dam another feed carries with volumes go to the universe only: this
// rate-only monthly row would otherwise become the latest observation and
// blank the dam page's volume, or drop into a computed rate series as a spike.
// That includes 竹原/猪ノ鼻/猪鼻第2, for which awaji-suido writes volumes. The
// row pairing 呑吐 and 大川瀬 has one figure for two dams and stays unresolved.
//
// Priority 287. Cron daily 01:17 UTC (10:17 JST).

import { ingestTask } from '../ingest/run.ts';
import type { Bind, Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.HYOGO_SUIGEN_URL ?? 'https://web.pref.hyogo.lg.jp/kk05/ac07_000000162.html';

const PREF_CODE = '28';
const SOURCE_ID = 'hyogo-suigen';

/** The master spells 猪ノ鼻（いのはな）第二ダム as 猪鼻第2. */
const MASTER_NAMES: Record<string, string> = { 猪ノ鼻第二ダム: '猪鼻第2' };

// Rows whose dam another feed already carries with a storage volume (checked on
// prod 2026-09-28). Keyed by the page's name, furigana stripped.
const COVERED_ELSEWHERE: Record<string, true> = {
  // kasenbosai / hyogo-bodik / jwa-junpo, every 10 minutes.
  青野ダム: true,
  一庫ダム: true,
  生野ダム: true,
  大路ダム: true,
  三宝ダム: true,
  栗柄ダム: true,
  成相ダム: true,
  牛内ダム: true,
  // awaji-suido (淡路広域水道企業団 各水源地の貯水状況) publishes their volumes.
  竹原ダム: true,
  猪ノ鼻ダム: true,
  猪ノ鼻第二ダム: true,
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** Page name, furigana stripped; dams sharing a row joined by 「・」. Stamp and universe key. */
  name: string;
  /** The dams the row covers — more than one when a row pairs two dams. */
  damNames: string[];
  /** 貯水率 as a 0..1 fraction; null when the cell is not a percentage. */
  storageRate: number | null;
  /** The 貯水率 cell as printed (folded), for its marker when there is no figure. */
  rateCell: string;
}

export interface ParsedPage {
  /** The 【…現在】 survey date at 00:00 JST, or null when the caption is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

export function parseHyogoSuigen(html: string): ParsedPage {
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)]
    .map((m) => m[1] ?? '')
    .find((body) => /<th[^>]*>\s*ダム名\s*<\/th>/.test(body));
  if (!table) return { observedAt: null, rows: [] };

  const d = flat(table.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] ?? '').match(
    /令和(\d+|元)年(\d{1,2})月(\d{1,2})日現在/,
  );
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    if (cells.length < 4) continue;
    // A shared row puts each dam in its own <p> (or line) of the name cell.
    const damNames = (cells[0] ?? '')
      .split(/<\/p>|<br\s*\/?>/)
      .map((part) => flat(part).replace(/[(（][^)）]*[)）]/g, ''))
      .filter((n) => n !== '');
    if (damNames.length === 0) continue;
    const rateCell = flat(cells[3] ?? '');
    const pct = rateCell.match(/^(\d+(?:\.\d+)?)%$/)?.[1];
    rows.push({
      name: damNames.join('・'),
      damNames,
      storageRate: pct === undefined ? null : Number(pct) / 100,
      rateCell,
    });
  }
  return { observedAt, rows };
}

// --- entries ----------------------------------------------------------------

/** A cell the page prints in place of a figure. */
const MARK_RE = /^[－―ー‐—-]+$/;

function rowReading(row: ParsedRow, observedAt: Date | null): Reading {
  if (row.storageRate === null) {
    return MARK_RE.test(row.rateCell)
      ? { state: 'empty', mark: row.rateCell }
      : { state: 'unreadable', why: `貯水率 cell 「${row.rateCell}」` };
  }
  if (!observedAt) return { state: 'unreadable', why: 'no 【…現在】 caption' };
  // The 【…現在】 date is the newest value the page publishes: holding it
  // keeps the dam covered through the month until the next survey.
  return { state: 'values', observations: [{ observedAt, storageRate: row.storageRate }] };
}

/**
 * Every row of the table. A row binds only the master whose name is the
 * page's (live twin of a （元）/（再） pair); one figure for two dams belongs
 * to neither.
 */
export function hyogoSuigenEntries(html: string): Entry[] {
  const { observedAt, rows } = parseHyogoSuigen(html);
  return rows.map((p) => {
    const bind: Bind =
      p.damNames.length > 1 ? 'never' : { name: MASTER_NAMES[p.name] ?? p.name, exact: true };
    return {
      key: p.name,
      name: p.name,
      pref: PREF_CODE,
      bind,
      ...(COVERED_ELSEWHERE[p.name] ? { dontWrite: 'another feed carries its volume' } : {}),
      reading: rowReading(p, observedAt),
    };
  });
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
  const entries = hyogoSuigenEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} rows`);
  return { entries, dated: true };
});
