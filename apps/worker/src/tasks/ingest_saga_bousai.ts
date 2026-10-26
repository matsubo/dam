// apps/worker/src/tasks/ingest_saga_bousai.ts
//
// 佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム hourly.
//
//   岸川 / 庭木 / 繁昌 / 天ヶ瀬 / 平木場 / 伊岐佐 / 都川内 /
//   井手口川 / 竜門 / 有田 / 古木場 / 本部 / 矢筈 / 狩立日ノ峯 /
//   中木庭 / 岩屋川内 / 横竹 / 深浦 / 河内
//
// Source:
//   http://kasen.pref.saga.lg.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus
//   ?dk=4&sv=3&pg={1,2,3}
//   Shift_JIS HTML; 3 pages (7+7+5 dams). Table is *transposed*: dam names
//   are column headers, observation types are row labels (using ideographic
//   space U+3000 as separator).
//
// Observation rows extracted:
//   観測時刻       "MM/DD HH:MM" JST (per column)
//   貯水位 EL [m]
//   全流入量 [m3/s]
//   全放流量 [m3/s]
//   貯水量 [1000m3] → storageVolumeM3 × 1000  (some dams only)
//   貯水率 [%]     → storageRate ÷ 100         (some dams only)
//
// Year inferred from "YYYY年" pattern in the page header.
//
// A column that is 「***」 (欠測) or blank in every value row is provider-marked
// empty: on 2026-09-28 天ヶ瀬 and 河内 printed 「***」, and 深浦 was blank under
// a 07/06 観測時刻. The 現況表 carries no station ids, so the printed name is
// the key. A page that cannot be fetched fails the run: the list is the three
// pages together.
//
// Priority 308. Cron hourly at :40.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL =
  process.env.SAGA_BOUSAI_URL ??
  'http://kasen.pref.saga.lg.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus';

const PREF_CODE = '41';
const SOURCE_ID = 'saga-bousai';
const PAGE_COUNT = 3;

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  sagaName: string;
  observedAt: Date | null;
  storageRate: number | null;
  storageVolumeM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /**
   * Every value cell is 「***」 (欠測) or blank, as 天ヶ瀬 / 河内 / 深浦 print
   * it — on a page that has its 貯水位 row, so a page without one cannot say
   * a dam is empty.
   */
  marked: boolean;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "MM/DD HH:MM" JST with an explicit year → UTC.
 * Returns null on parse failure.
 */
export function parseSagaTimestamp(s: string, year: number): Date | null {
  const m = s.match(/^(\d{1,2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number];
  const d = new Date(Date.UTC(year, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the 4-digit year from "YYYY年..." in the page header.
 *
 * The table itself only carries MM/DD, so the year has to come from the header
 * or, failing that, the clock. The fallback uses the JST year because the page
 * reports JST: between 15:00 UTC on 31 Dec and midnight the UTC year is already
 * one behind what the page means.
 */
export function extractYear(html: string, now: Date = new Date()): number {
  const m = html.match(/(\d{4})年/);
  if (m) return Number(m[1]);
  return new Date(now.getTime() + 9 * 3_600_000).getUTCFullYear();
}

/**
 * Parse a single page's transposed dam table.
 * Returns one ParsedRow per dam column.
 */
export function parseSagaPage(html: string, now: Date = new Date()): ParsedRow[] {
  const year = extractYear(html, now);

  // Build label → [col values] from every <tr>
  const rowMap = new Map<string, string[]>();
  let damNames: string[] = [];

  for (const trMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rawCells = Array.from(
      (trMatch[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
    ).map((c) => cleanCell(c[1] ?? ''));

    if (rawCells.length < 2) continue;
    const label = rawCells[0] ?? '';

    if (label === '局名') {
      damNames = rawCells.slice(1);
    } else {
      rowMap.set(label, rawCells.slice(1));
    }
  }

  if (damNames.length === 0) return [];

  const timeRow = rowMap.get('観測時刻') ?? [];
  const levelRow = rowMap.get('貯水位 EL [m]') ?? [];
  const inflowRow = rowMap.get('全流入量 [m3/s]') ?? [];
  const outflowRow = rowMap.get('全放流量 [m3/s]') ?? [];
  const volRow = rowMap.get('貯水量 [1000m3]') ?? [];
  const rateRow = rowMap.get('貯水率 [%]') ?? [];
  const valueRows = [levelRow, inflowRow, outflowRow, volRow, rateRow];

  const rows: ParsedRow[] = [];

  for (let i = 0; i < damNames.length; i++) {
    const sagaName = damNames[i] ?? '';
    if (!sagaName || (!sagaName.includes('ダム') && !sagaName.includes('貯水池'))) continue;

    const tsStr = timeRow[i] ?? '';
    const observedAt = parseSagaTimestamp(tsStr, year);

    const ratePct = parseNum(rateRow[i] ?? '');
    const volRaw = parseNum(volRow[i] ?? '');

    rows.push({
      sagaName,
      observedAt,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      waterLevelM: parseNum(levelRow[i] ?? ''),
      inflowM3s: parseNum(inflowRow[i] ?? ''),
      outflowM3s: parseNum(outflowRow[i] ?? ''),
      // 「***」 is the provider's 欠測; blank is a quantity it does not publish.
      marked: rowMap.has('貯水位 EL [m]') && valueRows.every((row) => /^\**$/.test(row[i] ?? '')),
    });
  }

  return rows;
}

/**
 * A column with a 貯水位 or a 貯水量 has values; one 「***」 or blank in every
 * value row is provider-marked empty; anything else may be our parser.
 */
export function sagaReading(p: ParsedRow): Reading {
  if (p.waterLevelM !== null || p.storageVolumeM3 !== null) {
    if (!p.observedAt) return { state: 'unreadable', why: 'no 観測時刻' };
    return {
      state: 'values',
      observations: [
        {
          observedAt: p.observedAt,
          storageVolumeM3: p.storageVolumeM3,
          storageRate: p.storageRate,
          inflowM3s: p.inflowM3s,
          outflowM3s: p.outflowM3s,
          waterLevelM: p.waterLevelM,
        },
      ],
    };
  }
  if (p.marked) return { state: 'empty', mark: '「***」 or blank in every value row' };
  return { state: 'unreadable', why: 'no 貯水位 or 貯水量' };
}

/**
 * Names the ladder cannot reach. The master lists 狩立 (NDI 2515) and 日ノ峯
 * (NDI 2510) as two rows; 狩立日ノ峯ダム's column has always bound 狩立, the row
 * kasenbosai's station is stamped on too.
 */
const BIND_NAMES: Readonly<Record<string, string>> = {
  狩立日ノ峯ダム: '狩立',
};

/** Every dam column of the pages, in page order. */
export function sagaEntries(rows: ParsedRow[]): Entry[] {
  return rows.map((p) => {
    const bindName = BIND_NAMES[p.sagaName];
    return {
      key: p.sagaName,
      name: p.sagaName,
      pref: PREF_CODE,
      ...(bindName ? { bind: { name: bindName } } : {}),
      reading: sagaReading(p),
    };
  });
}

// --- task -------------------------------------------------------------------

async function fetchPage(page: number): Promise<string> {
  const r = await fetch(`${BASE_URL}?dk=4&sv=3&pg=${page}`, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} on page ${page}`);
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async (log) => {
  const pages = await Promise.all(Array.from({ length: PAGE_COUNT }, (_, i) => fetchPage(i + 1)));
  const rows = pages.flatMap((html) => parseSagaPage(html));
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  return { entries: sagaEntries(rows) };
});
