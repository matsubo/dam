// apps/worker/src/tasks/ingest_jwa_yoshino.ts
//
// 水資源機構 吉野川上流総合管理所 — 吉野川水系 5 ダム.
// Real-time page auto-refreshed every 5 minutes; fetched hourly.
//
//   吉野川水系: 池田(徳島) / 早明浦(高知) / 新宮(徳島) / 富郷(愛媛) / 柳瀬(愛媛)
//
// Source: https://www.water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html
// Format: UTF-8 HTML; "観測日時：YYYY年MM月DD日 HH時MM分" (JST); hourly cadence.
//         貯水位(EL.m)・流入量・全放流量 for all 5 dams.
//         早明浦ダムのみ「利水貯水率[速報値]」もあり (storageRate).
//         "CC" = 閉局 (communication closed), "**" = 調整中: the page's own marks.
// License: 水資源機構 published; 出典明示で再配布可.
//
// The same 流域概況図 also carries weirs (新井堰, 影井堰, 瀬戸川取水堰,
// 地蔵寺川取水堰) and a 鏡ダム 自流量 point, none with a 貯水位: they are
// listed with what they print (水位, 流入量/自流量/流量, 放流量) but never
// bound to a master dam, so never written.
//
// These dams are in jwa-junpo (10-day, priority 290). This adapter upgrades to
// hourly cadence and adds 水位 (EL.m). 早明浦ダムは四国の給水危機指標として最も
// 注目されるダム (Shikoku water-supply crisis indicator).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_YOSHINO_URL ??
  'https://www.water.go.jp/mizu/ikeda/mizuinfo/dyn/html/p0001/60/p000101.html';
const SOURCE_ID = 'jwa-yoshino';
const SAMEURA = '早明浦ダム';

/**
 * The prefectures each dam's master may be in, by printed name. A multi-code
 * entry is a lookup scope, not an attribution — its first code is sometimes
 * the wrong prefecture (新宮 is 愛媛, not 徳島).
 */
const PREFS_BY_NAME: Readonly<Record<string, string[]>> = {
  池田ダム: ['36'], // 徳島
  早明浦ダム: ['39', '36'], // 高知
  新宮ダム: ['36', '38'],
  富郷ダム: ['38'], // 愛媛
  柳瀬ダム: ['38'], // 愛媛
};

/** The page's region, for the blocks that are not one of its five reservoirs. */
const BASIN_PREFS = ['36', '38', '39'];

/** Cells the page prints instead of a number. */
const MARKS: Readonly<Record<string, true>> = {
  '―': true,
  '-': true,
  '—': true,
  CC: true,
  cc: true,
  '**': true,
};

export interface ParsedRow {
  yoshinoName: string;
  /** A reservoir block (it prints 貯水位); the others are weirs and flow points. */
  reservoir: boolean;
  waterLevelM: Cell;
  storageRatePct: Cell; // 早明浦のみ: 利水貯水率[速報値]
  inflowM3s: Cell;
  outflowM3s: Cell;
}

function textOf(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/　/g, ' ')
    .trim();
}

function parseCell(s: string): Cell {
  const cleaned = s.replace(/[,\s　]/g, '');
  return cell(cleaned ? Number(cleaned) : null, MARKS[cleaned] === true);
}

/**
 * Parse JST timestamp from `<span id="data-time">YYYY年MM月DD日 HH時MM分</span>`.
 * Subtract 9 hours to get UTC; JS Date.UTC handles out-of-range hours.
 */
export function parseYoshinoTimestamp(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{1,2})時(\d{2})分/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, day, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The page's facility blocks, in page order. Each is wrapped in
 * `<div class="str-data2"...>NAME</div>`; a block runs to the next
 * `str-data2`.
 */
function facilitySections(html: string): { name: string; section: string }[] {
  const heads = [...html.matchAll(/class="str-data2"[^>]*>([^<]*)<\/div>/g)];
  return heads.map((h, i) => ({
    name: textOf(h[1] ?? ''),
    section: html.slice(h.index, heads[i + 1]?.index ?? html.length),
  }));
}

/**
 * The value cell of the first `<th>` whose text starts with `label`, or
 * undefined when no such `<th>`. The unit sits inside the `<th>` as markup
 * (`流入量(<span class='unit'>m<sup>3</sup>/s</span>)`), so the value must
 * come from the `<td>`, never from the first digit after the label: that is
 * the 3 of m³.
 */
function extractLabeled(html: string, label: string): Cell | undefined {
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([^<]*)/g)) {
    if (textOf(m[1] ?? '').startsWith(label)) return parseCell(m[2] ?? '');
  }
  return undefined;
}

/** One row per facility block, in page order. */
export function parseYoshinoHtml(html: string): { observedAt: Date | null; rows: ParsedRow[] } {
  const observedAt = parseYoshinoTimestamp(html);
  const rows: ParsedRow[] = [];

  // 早明浦ダム利水貯水率[速報値] is in the global summary box at the top of the page.
  const sameuraRate = extractLabeled(html, `${SAMEURA}利水貯水率[速報値]`) ?? null;

  const seen = new Set<string>();
  for (const { name, section } of facilitySections(html)) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const storageLevel = extractLabeled(section, '貯水位');
    if (storageLevel !== undefined) {
      rows.push({
        yoshinoName: name,
        reservoir: true,
        waterLevelM: storageLevel,
        storageRatePct: name === SAMEURA ? sameuraRate : null,
        inflowM3s: extractLabeled(section, '流入量') ?? null,
        // 全放流量 = total outflow (controlled release + spillage)
        outflowM3s: extractLabeled(section, '全放流量') ?? null,
      });
      continue;
    }
    // A weir or flow point: 水位(m), 流入量 / 自流量 / 流量, the first 放流量.
    rows.push({
      yoshinoName: name,
      reservoir: false,
      waterLevelM: extractLabeled(section, '水位') ?? null,
      storageRatePct: null,
      inflowM3s:
        extractLabeled(section, '流入量') ??
        extractLabeled(section, '自流量') ??
        extractLabeled(section, '流量') ??
        null,
      outflowM3s: extractLabeled(section, '放流量') ?? null,
    });
  }
  return { observedAt, rows };
}

/** One dam's reading at the page's 観測日時. */
export function yoshinoReading(row: ParsedRow, observedAt: Date | null): Reading {
  const cells: Cell[] = [row.waterLevelM, row.inflowM3s, row.outflowM3s];
  const state = cellState(row.yoshinoName === SAMEURA ? [...cells, row.storageRatePct] : cells);
  if (state === 'empty') return { state, mark: 'CC (閉局) / ** (調整中) on every field' };
  if (state === 'unreadable') return { state, why: 'no 水位, 流入量 or 放流量 number' };
  if (!observedAt) return { state: 'unreadable', why: 'no 観測日時 on the page' };
  const ratePct = numberIn(row.storageRatePct);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(row.waterLevelM),
        inflowM3s: numberIn(row.inflowM3s),
        outflowM3s: numberIn(row.outflowM3s),
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every facility on the page, keyed by its printed name. */
export function yoshinoEntries(html: string): Entry[] {
  const { observedAt, rows } = parseYoshinoHtml(html);
  return rows.map((row) => {
    const prefs = row.reservoir ? (PREFS_BY_NAME[row.yoshinoName] ?? []) : BASIN_PREFS;
    return {
      key: row.yoshinoName,
      name: row.yoshinoName,
      pref: prefs.length === 0 ? null : prefs.length === 1 ? (prefs[0] ?? null) : prefs,
      ...(row.reservoir ? {} : { bind: 'never' as const }),
      reading: yoshinoReading(row, observedAt),
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
  const entries = yoshinoEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} facilities listed`);
  return { entries };
});
