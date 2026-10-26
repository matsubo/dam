// apps/worker/src/tasks/ingest_aitoyo.ts
//
// Third real-observation source. 公益財団法人 愛知・豊川用水振興協会
// (あいとよネット) publishes a daily-updated table of 利水容量・貯水量・貯水率
// for the 7 dams that supply 愛知 / 木曽川 / 豊川 / 矢作川 systems:
//
//   木曽川水系 4 dams: 牧尾 / 阿木川 / 味噌川 / 岩屋
//   豊川水系   1 dam:  宇連 (+ 豊川用水全体 aggregate, recorded but never bound)
//   矢作川水系 2 dams: 矢作 / 羽布
//
// Source: https://www.aitoyo.or.jp/fountainhead/dam/
// Format: HTML table (TablePress plugin) headed 「YYYY年M月D日現在」; the page
//         notes 「貯水率は、当日の24時（木曽川・豊川）または9時（矢作川）の
//         値」, so a row is stamped at that day's 24:00 or 09:00 JST. The page
//         shows one day only, updated on business days (Monday shows Sunday)
//         at a varying hour, often after 11:00 JST.
// License: 公益財団法人 publication; 出典明示で再配布可 (public utility data).
//
// Cadence trade-off: daily (vs jwa-junpo's 10-day) for 5 overlap dams.
// Priority 295 (below tokyo-waterworks 300 since tokyo is fresher by ~1 day,
// but above jwa-junpo 290 since aitoyo is fresher than jwa-junpo for overlap).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.AITOYO_URL ?? 'https://www.aitoyo.or.jp/fountainhead/dam/';
const SOURCE_ID = 'aitoyo';

// readingHourJst: the page's 当日 hour for the system — 24 (木曽川/豊川) or 9 (矢作川).
const DAMS: Record<string, { pref: string | readonly string[]; readingHourJst: 24 | 9 }> = {
  // 木曽川水系 (all overlap with jwa-junpo)
  牧尾ダム: { pref: '20', readingHourJst: 24 }, // 長野
  阿木川ダム: { pref: '21', readingHourJst: 24 }, // 岐阜
  味噌川ダム: { pref: '20', readingHourJst: 24 },
  岩屋ダム: { pref: '21', readingHourJst: 24 },
  // 豊川水系 (overlap)
  宇連ダム: { pref: '23', readingHourJst: 24 }, // 愛知
  // 矢作川水系 (NEW vs jwa-junpo / tokyo-waterworks)
  矢作ダム: { pref: ['23', '20'], readingHourJst: 9 }, // 愛知/長野 boundary
  羽布ダム: { pref: '23', readingHourJst: 9 }, // 愛知
};

// The 豊川 system's whole pool: recorded, never bound. Not a total of rows
// on this page — its 利水容量 51,820 千m³ is 宇連 28,420 + 大島 11,300 +
// 地区内調整池 12,100 (jwa-chubu's report), and only 宇連 is listed here.
const AGGREGATE = '豊川用水全体';
const AGGREGATE_HOUR_JST = 24;

export interface ParsedRow {
  aitoyoName: string;
  storageCapacityThouM3: Cell;
  storageVolumeThouM3: Cell;
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

/** A number, the page's own "―"/"-" mark, or null when neither. */
function parseCell(s: string): Cell {
  const cleaned = s.replace(/[,\s　]/g, '');
  const n = cleaned ? Number(cleaned) : Number.NaN;
  return cell(n, cleaned === '―' || cleaned === '-');
}

/** 「2026年9月27日現在」 → that calendar date as a UTC-midnight Date. */
function parseAitoyoDate(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日現在/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The 「…日現在」 day and every named row of the dam-storage table, in page order. */
export function parseAitoyoHtml(html: string): { day: Date | null; rows: ParsedRow[] } {
  const day = parseAitoyoDate(html);
  const rows: ParsedRow[] = [];

  // Restrict to the dam-storage table. The page has multiple tables; this
  // one is the only one with column-3..column-7 storage cells.
  const tableMatch = html.match(/<table[^>]*tablepress-id-top[^>]*>([\s\S]*?)<\/table>/);
  const tableHtml = tableMatch?.[1] ?? '';

  const seen = new Set<string>();
  const rowMatches = tableHtml.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rowMatches) {
    // Cells with `column-2` carry the dam-name <a>. column-3 is 利水容量,
    // column-4 is 貯水量, column-5 is 貯水率. Use class-keyed extraction so
    // the (variable-width) 水系 rowspan column doesn't shift indices.
    const cellByClass: Record<string, string> = {};
    const cellMatches = row.matchAll(/<td\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/g);
    for (const cm of cellMatches) {
      const cls = (cm[1] ?? '').split(/\s+/).find((c) => /^column-\d+$/.test(c));
      if (cls) cellByClass[cls] = textOf(cm[2] ?? '');
    }
    const name = cellByClass['column-2'];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({
      aitoyoName: name,
      storageCapacityThouM3: parseCell(cellByClass['column-3'] ?? ''),
      storageVolumeThouM3: parseCell(cellByClass['column-4'] ?? ''),
      storageRatePct: parseCell(cellByClass['column-5'] ?? ''),
    });
  }
  return { day, rows };
}

/** A row's reading at 当日 `readingHourJst` of the page's day. */
export function aitoyoReading(row: ParsedRow, day: Date, readingHourJst: number): Reading {
  const state = cellState([row.storageCapacityThouM3, row.storageVolumeThouM3, row.storageRatePct]);
  if (state === 'empty') return { state, mark: '― in 利水容量, 貯水量 and 貯水率' };
  const volume = numberIn(row.storageVolumeThouM3);
  const rate = numberIn(row.storageRatePct);
  if (numberIn(row.storageCapacityThouM3) === null || volume === null || rate === null) {
    return { state: 'unreadable', why: '利水容量, 貯水量 or 貯水率 is not a number' };
  }
  return {
    state: 'values',
    observations: [
      {
        // JST hour h of the day = UTC hour h - 9 (24 → 15:00Z the same date).
        observedAt: new Date(day.getTime() + (readingHourJst - 9) * 3_600_000),
        storageVolumeM3: volume * 1_000,
        storageRate: Math.max(0, Math.min(1, rate / 100)),
      },
    ],
  };
}

/** The seven dams alone, unreadable: what is recorded when the page cannot be read. */
function unreadableDams(why: string): Entry[] {
  return Object.entries(DAMS).map(([name, { pref }]) => ({
    key: name,
    name,
    pref,
    reading: { state: 'unreadable', why },
  }));
}

/**
 * Every row of the table, then any of the seven dams it no longer lists
 * (unreadable). A row new on the page is recorded, not written: its 当日
 * hour (24 or 9) is unknown until it is added to DAMS.
 */
export function aitoyoEntries(html: string): Entry[] {
  const { day, rows } = parseAitoyoHtml(html);
  if (!day || rows.length === 0) {
    return unreadableDams('no 「…日現在」 date or no tablepress-id-top table on the page');
  }
  const entries: Entry[] = rows.map((row) => {
    const name = row.aitoyoName;
    const dam = DAMS[name];
    if (dam) {
      return {
        key: name,
        name,
        pref: dam.pref,
        reading: aitoyoReading(row, day, dam.readingHourJst),
      };
    }
    if (name === AGGREGATE) {
      return {
        key: name,
        name,
        pref: '23',
        bind: 'never',
        reading: aitoyoReading(row, day, AGGREGATE_HOUR_JST),
      };
    }
    return {
      key: name,
      name,
      pref: null,
      dontWrite: 'new on the page',
      reading: { state: 'unreadable', why: 'its 当日 hour is not known' },
    };
  });
  const listed = new Set(rows.map((r) => r.aitoyoName));
  for (const e of unreadableDams('not on the page')) if (!listed.has(e.key)) entries.push(e);
  return entries;
}

export default ingestTask(SOURCE_ID, async (log) => {
  let html: string;
  try {
    const r = await fetch(PAGE_URL, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${PAGE_URL}`);
    html = await r.text();
  } catch (err) {
    // The seven dams are known in advance: record them unreadable, and the
    // run fails the job so it is retried.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: unreadableDams(why) };
  }
  return { entries: aitoyoEntries(html) };
});
