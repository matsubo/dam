// apps/worker/src/tasks/ingest_jwa_junpo.ts
//
// Second real-observation source. 水資源機構 (JWA) publishes a 旬報 (10-day
// report) for the 26 JWA-operated dams across 7 major water systems:
//
//   利根川 4 dams: 矢木沢 / 奈良俣 / 下久保 / 草木
//   荒川   2 dams: 浦山 / 滝沢
//   木曾川 5 dams: 徳山 / 岩屋 / 阿木川 / 牧尾 / 味噌川
//   豊川   2 dams: 宇連 / 大島
//   淀川   8 dams: 高山 / 青蓮寺 / 室生 / 布目 / 比奈知 / 川上 / 一庫 / 日吉
//   吉野川 1 dam:  早明浦
//   筑後川 4 dams: 江川 / 小石川原 / 寺内 / 大山
//
// Source: https://www.water.go.jp/honsya/honsya/suigen/junpo/index.html
// Format: HTML table, ~10-day granularity (JWA publishes on the 1st, 11th,
//         and 21st of each month, so the index always shows the latest).
//         Statutory open data (independent administrative agency).
//
// Cadence trade-off: 10 days is much coarser than tokyo-waterworks' daily,
// but JWA covers 20 additional dams (6 overlap with tokyo-waterworks) that
// no daily prefectural source publishes. The chart UI smooths missing days
// from the most recent observed value, so a 10-day step is fine for the
// storage-volume timeline.
//
// The table also prints synthesis rows (上流9ダム, 銅山川3ダム): sums over
// dams the same table lists, so they are not universe entries.
// backfill_jwa_junpo.ts walks the past 旬報 archive with the same parser.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.JWA_JUNPO_URL ?? 'https://www.water.go.jp/honsya/honsya/suigen/junpo/index.html';
const SOURCE_ID = 'jwa-junpo';

/**
 * Every dam the 旬報 lists, by its printed name: the prefectures its master
 * may be in (大島 exists in 岐阜 and 愛知; only the 愛知 one is in JWA's 豊川
 * system) and, where the master spells it differently, the master's name.
 */
export const JUNPO_DAMS: Readonly<Record<string, { prefs: string[]; masterName?: string }>> = {
  // 利根川 (overlaps with tokyo-waterworks; serves as cross-source confirmation)
  矢木沢ダム: { prefs: ['10'] },
  奈良俣ダム: { prefs: ['10'] },
  下久保ダム: { prefs: ['10', '11'] },
  草木ダム: { prefs: ['10'] },
  // 荒川 (overlap)
  浦山ダム: { prefs: ['11'] },
  滝沢ダム: { prefs: ['11'] },
  // 木曾川
  徳山ダム: { prefs: ['21'] }, // 岐阜
  岩屋ダム: { prefs: ['21'] },
  阿木川ダム: { prefs: ['21'] },
  牧尾ダム: { prefs: ['20'] }, // 長野
  味噌川ダム: { prefs: ['20'] },
  // 豊川
  宇連ダム: { prefs: ['23'] }, // 愛知
  大島ダム: { prefs: ['23'] },
  // 淀川
  高山ダム: { prefs: ['26'] }, // 京都
  青蓮寺ダム: { prefs: ['24'] }, // 三重
  室生ダム: { prefs: ['29'] }, // 奈良
  布目ダム: { prefs: ['29'] },
  比奈知ダム: { prefs: ['24'] },
  川上ダム: { prefs: ['24'] },
  一庫ダム: { prefs: ['28'] }, // 兵庫
  日吉ダム: { prefs: ['26'] },
  // 吉野川
  早明浦ダム: { prefs: ['39'] }, // 高知
  // 筑後川
  江川ダム: { prefs: ['40'] }, // 福岡
  // junpo lists 小石川原, the master is 小石原川
  小石川原ダム: { prefs: ['40'], masterName: '小石原川' },
  寺内ダム: { prefs: ['40'] },
  大山ダム: { prefs: ['44'] }, // 大分
};

/** A synthesis row, a sum over dams the table lists: 上流9ダム, 銅山川3ダム. */
const SYNTHESIS_ROW = /\dダム$/;

/** Cells the page prints instead of a number. */
const MARKS: Readonly<Record<string, true>> = { '―': true, '-': true, '*': true, '**': true };

export interface JunpoRow {
  jwaName: string;
  storageCapacityThouM3: number | null; // 利水容量, 千m³
  storageVolumeThouM3: Cell; // 貯水量, 千m³
  storageRatePct: Cell; // 貯水率 (current), %
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
  const n = cleaned ? Number(cleaned) : null;
  return cell(n, MARKS[cleaned] === true);
}

/**
 * Parse "令和8年4月21日" → JST midnight Date.
 * 令和 (Reiwa) era began 2019-05-01; year N → Gregorian 2018+N.
 */
export function parseReportDate(text: string): Date | null {
  const m = text.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  // JST midnight = 15:00 UTC the previous day.
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse the junpo HTML into one row per listed dam, in page order. */
export function parseJwaJunpoHtml(html: string): { reportDate: Date | null; rows: JunpoRow[] } {
  const reportDate = parseReportDate(html);
  const out: JunpoRow[] = [];

  // The page has multiple <table> elements. Only the first one — the
  // 「ダムの状況（利水容量に対する貯水率）」 table — has 貯水量/貯水率 in
  // 千m³ and %. Subsequent tables hold 月降水量 / 年降水量 (rainfall, mm)
  // for the same dams; if we walked them with the same parsing the
  // numeric values would silently be assigned to the wrong fields.
  const tableMatches = html.match(/<table\b[\s\S]*?<\/table>/g) ?? [];
  const storageTable = tableMatches.find((t) => /貯水率/.test(t)) ?? '';
  if (!storageTable) return { reportDate, rows: out };
  const seen = new Set<string>();

  // Every data row ends with the dam name and six cells:
  //   ダム名 / 利水容量marker / 利水容量 / 貯水量 / 貯水率(現在) /
  //   貯水率(平年) / 貯水率(平年比).
  // With rowspan in the 水系 column the 水系 cell only opens the first row
  // of a system, so the name is the seventh cell from the end. The two
  // header rows are shorter.
  const rowMatches = storageTable.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rowMatches) {
    const cellMatches = row.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g) ?? [];
    if (cellMatches.length < 7) continue;
    const cells = cellMatches.map((c) => textOf(c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/g, '')));
    const nameIdx = cells.length - 7;
    const name = cells[nameIdx] ?? '';
    if (!name || SYNTHESIS_ROW.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      jwaName: name,
      storageCapacityThouM3: numberIn(parseCell(cells[nameIdx + 2] ?? '')),
      storageVolumeThouM3: parseCell(cells[nameIdx + 3] ?? ''),
      storageRatePct: parseCell(cells[nameIdx + 4] ?? ''),
    });
  }
  return { reportDate, rows: out };
}

/** One row's reading at the report date. */
export function junpoReading(row: JunpoRow, reportDate: Date | null): Reading {
  const state = cellState([row.storageVolumeThouM3, row.storageRatePct]);
  if (state === 'empty') return { state, mark: '貯水量 and 貯水率 printed as ―/*' };
  if (state === 'unreadable') return { state, why: 'no 貯水量 or 貯水率 number' };
  if (!reportDate) return { state: 'unreadable', why: 'no 令和N年M月D日 on the page' };
  const volumeThou = numberIn(row.storageVolumeThouM3);
  const ratePct = numberIn(row.storageRatePct);
  return {
    state: 'values',
    observations: [
      {
        observedAt: reportDate,
        storageVolumeM3: volumeThou != null ? volumeThou * 1_000 : null,
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      },
    ],
  };
}

/** Every dam the 旬報 lists, keyed by its printed name. */
export function junpoEntries(html: string): Entry[] {
  const { reportDate, rows } = parseJwaJunpoHtml(html);
  return rows.map((row) => {
    const dam = JUNPO_DAMS[row.jwaName];
    const prefs = dam?.prefs ?? [];
    return {
      key: row.jwaName,
      name: row.jwaName,
      // A multi-code entry (下久保 straddles 群馬/埼玉) is a lookup scope, not
      // an attribution.
      pref: prefs.length === 0 ? null : prefs.length === 1 ? (prefs[0] ?? null) : prefs,
      ...(dam?.masterName ? { bind: { name: dam.masterName } } : {}),
      reading: junpoReading(row, reportDate),
    };
  });
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = junpoEntries((await upstream.fetch(PAGE_URL)).text());
  log(`${SOURCE_ID}: ${entries.length} dams listed`);
  return { entries, dated: true };
});
