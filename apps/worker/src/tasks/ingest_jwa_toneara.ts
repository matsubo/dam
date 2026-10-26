// apps/worker/src/tasks/ingest_jwa_toneara.ts
//
// 水資源機構 関東支社 — 利根川ダム統合管理事務所 / 荒川ダム統合管理事務所.
// Publishes a daily-updated (0時 JST) table of storage volume and rate for
// 13 facilities in the 利根川 and 荒川 water systems:
//
//   利根川系 9: 矢木沢/奈良俣/藤原/相俣/薗原/八ッ場/下久保/草木/渡良瀬貯水池
//   荒川系  4: 二瀬/滝沢/浦山/荒川貯水池
//
// Source: https://www.water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html
// Format: Static HTML table; "令和N年M月D日0時現在"; units 万m³. Each system's
//         table ends with an 「9ダム合計」/「4ダム合計」 row, a sum over the
//         facilities above it, so not a universe entry.
// License: 水資源機構 published; 出典明示で再配布可.
//
// New coverage vs prior sources:
//   藤原/相俣/薗原/八ッ場/二瀬 are new dams not covered by jwa-junpo/aitoyo.
//   Overlap dams (矢木沢/奈良俣/下久保/草木/浦山/滝沢) get daily cadence here
//   instead of jwa-junpo's 10-day cadence.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_TONEARA_URL ??
  'https://www.water.go.jp/honsya/honsya/suigen/sokuhou/toneara/index.html';
const SOURCE_ID = 'jwa-toneara';

/**
 * The prefectures each listed facility's master may be in, by printed name.
 * A multi-code entry is a lookup scope, not an attribution — its first code
 * is sometimes the wrong prefecture (草木 is 群馬, not 栃木).
 */
const PREFS_BY_NAME: Readonly<Record<string, string[]>> = {
  // 利根川水系
  矢木沢ダム: ['10'], // 群馬
  奈良俣ダム: ['10'],
  藤原ダム: ['10'],
  相俣ダム: ['10'],
  薗原ダム: ['10'],
  八ッ場ダム: ['10', '20'],
  下久保ダム: ['10', '11'],
  草木ダム: ['09', '10'], // 栃木/群馬
  渡良瀬貯水池: ['08', '09', '10', '11'],
  // 荒川水系
  二瀬ダム: ['11'], // 埼玉
  滝沢ダム: ['11'],
  浦山ダム: ['11'],
  荒川貯水池: ['11', '13'],
};

/**
 * The master's name where it differs from the printed one: 渡良瀬貯水池 is
 * filed as 渡良瀬遊水地（一期）, 荒川貯水池 as 荒川調節池 (tokyo-waterworks
 * binds the same two names to them).
 */
const MASTER_NAME: Readonly<Record<string, string>> = {
  渡良瀬貯水池: '渡良瀬',
  荒川貯水池: '荒川',
};

/** Cells the page prints instead of a number. */
const DASHES: Readonly<Record<string, true>> = { '―': true, '-': true, '—': true };

export interface ParsedRow {
  tonaraName: string;
  storageVolumeManM3: Cell;
  storageRatePct: Cell;
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
  const cleaned = s.replace(/[,\s　%万m³/]/g, '');
  return cell(cleaned ? Number(cleaned) : null, DASHES[cleaned] === true);
}

/**
 * Parse "令和N年M月D日0時現在" → JST midnight (= UTC day-1 15:00).
 * Reiwa starts 2019 = 令和1, so year = N + 2018.
 */
export function parseToneAraTimestamp(text: string): Date | null {
  const m = text.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const yr = Number(m[1]) + 2018;
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse HTML table rows. Expected column layout per data row (<td> cells):
 *   [0] ダム名  [1] 利水容量(万m³)  [2] 前日(万m³)  [3] 現在(万m³)  [4] 現在貯水率(%)
 * Header rows are <th>; a 合計 row sums the facilities above it and is skipped.
 */
export function parseToneAraHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseToneAraTimestamp(html);
  const rows: ParsedRow[] = [];
  const seen = new Set<string>();

  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex iteration
  while ((m = rowRe.exec(html)) !== null) {
    const cells = [...(m[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      textOf(c[1] ?? ''),
    );
    if (cells.length < 5) continue;
    const name = cells[0] ?? '';
    if (!name || name.endsWith('合計') || seen.has(name)) continue;
    seen.add(name);
    // Column 3 = current storage (万m³), column 4 = storage rate (%).
    rows.push({
      tonaraName: name,
      storageVolumeManM3: parseCell(cells[3] ?? ''),
      storageRatePct: parseCell(cells[4] ?? ''),
    });
  }
  return { reportDate, rows };
}

/** One row's reading at the page's 0時 timestamp. */
export function toneAraReading(row: ParsedRow, reportDate: Date | null): Reading {
  const state = cellState([row.storageVolumeManM3, row.storageRatePct]);
  if (state === 'empty') return { state, mark: '貯水量 and 貯水率 printed as ―' };
  if (state === 'unreadable') return { state, why: 'no 現在貯水量 or 現在貯水率 number' };
  if (!reportDate) return { state: 'unreadable', why: 'no 令和N年M月D日 on the page' };
  const volumeMan = numberIn(row.storageVolumeManM3);
  const ratePct = numberIn(row.storageRatePct);
  return {
    state: 'values',
    observations: [
      {
        observedAt: reportDate,
        storageVolumeM3: volumeMan != null ? volumeMan * 10_000 : null, // 万m³ → m³
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every listed facility, keyed by its printed name. */
export function toneAraEntries(html: string): Entry[] {
  const { reportDate, rows } = parseToneAraHtml(html);
  return rows.map((row) => {
    const prefs = PREFS_BY_NAME[row.tonaraName] ?? [];
    const masterName = MASTER_NAME[row.tonaraName];
    return {
      key: row.tonaraName,
      name: row.tonaraName,
      pref: prefs.length === 0 ? null : prefs.length === 1 ? (prefs[0] ?? null) : prefs,
      ...(masterName ? { bind: { name: masterName } } : {}),
      reading: toneAraReading(row, reportDate),
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
  const entries = toneAraEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} facilities listed`);
  return { entries };
});
