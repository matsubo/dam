// apps/worker/src/tasks/ingest_tokyo_waterworks.ts
//
// First real-observation source. 東京都水道局 publishes a vol/rate/delta
// table for the reservoirs that supply Tokyo's drinking water:
//
//   利根川水系 9 dams: 矢木沢 / 奈良俣 / 藤原 / 相俣 / 薗原 / 八ッ場 /
//                      下久保 / 草木 / 渡良瀬貯水池
//   荒川水系   4 dams: 浦山 / 荒川貯水池 / 滝沢 / 二瀬
//   多摩川水系 2 rows: 小河内貯水池 / 村山・山口貯水池 (a three-reservoir total)
//
// Source: https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen.html
// Format: HTML table, one reading a day. Officially-public open data
//         (no UA gate, no scraping prohibition like kasenbosai/suimon).
//
// One observation per row:
//   observed_at    = the page's 「令和N年M月D日」 at its table's 「N時現在」
//                    (利根川 / 荒川 0時, 多摩川 7時; JST)
//   storage_volume = 貯水量(万m³) × 10_000
//   storage_rate   = 貯水率 / 100  (clipped to [0, 1])
//
// The page is updated on business days only: over a weekend or holiday it
// keeps the last business day's date, so a run then rewrites that day's row
// instead of copying it onto the run date.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const SOURCE_ID = 'tokyo-waterworks';

const PAGE_URL =
  process.env.TOKYO_WATERWORKS_URL ?? 'https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen.html';

// 東京都水道局 listing name → the name the master is searched by (the
// 「ダム」/「貯水池」 suffix varies) and the prefectures it may sit in.
const NAME_MAP: Array<{ tokyoName: string; masterName: string; prefCodes: string[] }> = [
  // 利根川水系
  { tokyoName: '矢木沢ダム', masterName: '矢木沢', prefCodes: ['10'] }, // 群馬
  { tokyoName: '奈良俣ダム', masterName: '奈良俣', prefCodes: ['10'] },
  { tokyoName: '藤原ダム', masterName: '藤原', prefCodes: ['10'] },
  { tokyoName: '相俣ダム', masterName: '相俣', prefCodes: ['10'] },
  { tokyoName: '薗原ダム', masterName: '薗原', prefCodes: ['10'] },
  { tokyoName: '八ッ場ダム', masterName: '八ッ場', prefCodes: ['10'] },
  { tokyoName: '下久保ダム', masterName: '下久保', prefCodes: ['10', '11'] }, // 群馬/埼玉
  { tokyoName: '草木ダム', masterName: '草木', prefCodes: ['10'] },
  { tokyoName: '渡良瀬貯水池', masterName: '渡良瀬', prefCodes: ['09', '10', '11'] }, // 栃木/群馬/埼玉
  // 荒川水系
  { tokyoName: '浦山ダム', masterName: '浦山', prefCodes: ['11'] }, // 埼玉
  { tokyoName: '荒川貯水池', masterName: '荒川', prefCodes: ['11'] },
  { tokyoName: '滝沢ダム', masterName: '滝沢', prefCodes: ['11'] },
  { tokyoName: '二瀬ダム', masterName: '二瀬', prefCodes: ['11'] },
  // 多摩川水系
  { tokyoName: '小河内貯水池', masterName: '小河内', prefCodes: ['13'] }, // 東京
];

// 村山・山口貯水池 totals three reservoirs: 貯水容量 3,435 万m³ is the 有効 of
// 村山上 (298.3), 村山下 (1,184.3) and 山口 (1,952.8, 埼玉). No master row
// holds that figure, so it is recorded as published and bound to no dam;
// migration 0162 gives it a not_dam_reason.
const RESERVOIR_TOTAL = '村山・山口貯水池';

/** Rows of each table that are not a reservoir. */
const NOT_A_ROW = new Set(['ダム名', '以上合計']);

export interface ParsedRow {
  tokyoName: string;
  observedAt: Date;
  storageVolumeWanM3: Cell; // 万m³
  storageRatePct: Cell; // %
}

/**
 * Strip HTML tags and decode entities. Robust enough for a vetted source page;
 * not a general-purpose HTML sanitiser.
 */
function textOf(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseNum(s: string): Cell {
  const cleaned = s.replace(/[,\s]/g, '');
  if (cleaned === '―' || cleaned === '-') return MARKED;
  return cleaned ? cell(Number(cleaned), false) : null;
}

/**
 * Parse suigen.html into one ParsedRow per reservoir row, each dated by the
 * page. In document order the page carries its date (「令和8年9月25日(金曜日)」,
 * 令和N = 2018+N), then one table per 水系 whose caption gives the hour
 * (「利根川水系　0時現在」, 「多摩川水系　7時現在」), then that table's rows.
 * The weekday keeps a nav link's 「令和5年3月31日事業廃止」 from passing for
 * the page date. Rows without a date and an hour above them are dropped, as
 * are the header, 以上合計 and the 4-cell 前年同日量 rows.
 */
export function parseTokyoWaterworksHtml(html: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  // Some capacity cells contain a nested <table> with its own <tr>. The
  // outer-row regex below is non-greedy and would otherwise stop at the
  // nested </tr>, eating the 3-cell inner row instead of the 5-cell outer
  // row. Replace only nested tables that sit inside a <td>, leaving the
  // top-level wrapping tables intact.
  const normalised = html.replace(/(<td\b[^>]*>)\s*<table\b[\s\S]*?<\/table>\s*/g, '$1_nested_');
  const tokens = normalised.matchAll(
    /令和(\d+)年(\d+)月(\d+)日[(（][月火水木金土日]曜日[)）]|(\d+)時現在|<tr\b[^>]*>[\s\S]*?<\/tr>/g,
  );
  let date: { year: number; month: number; day: number } | null = null;
  let hour: number | null = null;
  for (const t of tokens) {
    if (t[1] !== undefined) {
      date = { year: 2018 + Number(t[1]), month: Number(t[2]), day: Number(t[3]) };
      continue;
    }
    if (t[4] !== undefined) {
      hour = Number(t[4]);
      continue;
    }
    if (date === null || hour === null) continue;
    const cellMatches = t[0].match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g) ?? [];
    const cells = cellMatches.map((c) => textOf(c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/g, '')));
    if (cells.length < 5) continue;
    const name = cells[0] ?? '';
    if (!name || NOT_A_ROW.has(name)) continue;
    out.push({
      tokyoName: name,
      // JST = UTC+9.
      observedAt: new Date(Date.UTC(date.year, date.month - 1, date.day, hour - 9)),
      storageVolumeWanM3: parseNum(cells[2] ?? ''),
      storageRatePct: parseNum(cells[3] ?? ''),
    });
  }
  return out;
}

export function tokyoReading(row: ParsedRow): Reading {
  const state = cellState([row.storageVolumeWanM3, row.storageRatePct]);
  if (state === 'empty') return { state, mark: '― in 貯水量 and 貯水率' };
  if (state === 'unreadable') return { state, why: 'no 貯水量 or 貯水率' };
  const volume = numberIn(row.storageVolumeWanM3);
  const rate = numberIn(row.storageRatePct);
  return {
    state,
    observations: [
      {
        observedAt: row.observedAt,
        storageVolumeM3: volume != null ? volume * 10_000 : null,
        storageRate: rate != null ? Math.max(0, Math.min(1, rate / 100)) : null,
      },
    ],
  };
}

type Shape = Omit<Entry, 'reading'>;

function catalogue(): Shape[] {
  const dams = NAME_MAP.map(
    (m): Shape => ({
      key: m.tokyoName,
      name: m.tokyoName,
      // Several codes (渡良瀬 straddles 栃木/群馬/埼玉) are lookup scope, not an
      // attribution: pref_code is COALESCE-sticky once written.
      pref: m.prefCodes.length === 1 ? (m.prefCodes[0] ?? null) : m.prefCodes,
      ...(m.masterName === m.tokyoName.replace(/ダム$/, '')
        ? {}
        : { bind: { name: m.masterName } }),
    }),
  );
  // Spans 東京 and 埼玉 (山口), so no prefecture either.
  return [...dams, { key: RESERVOIR_TOTAL, name: RESERVOIR_TOTAL, pref: null, bind: 'never' }];
}

/**
 * The catalogue (14 dams and the 村山・山口 total), read from the page — a row
 * missing from it is unreadable — plus any reservoir row the catalogue lacks,
 * keyed by its printed name with no prefecture to search.
 */
export function tokyoEntries(html: string): Entry[] {
  const rows = parseTokyoWaterworksHtml(html);
  const byName = new Map(rows.map((r) => [r.tokyoName, r]));
  const shapes = catalogue();
  const known = shapes.map((s): Entry => {
    const row = byName.get(s.key);
    return {
      ...s,
      reading: row ? tokyoReading(row) : { state: 'unreadable', why: 'no dated row on the page' },
    };
  });
  const extra = rows
    .filter((r) => !shapes.some((s) => s.key === r.tokyoName))
    .map(
      (r): Entry => ({ key: r.tokyoName, name: r.tokyoName, pref: null, reading: tokyoReading(r) }),
    );
  return [...known, ...extra];
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  let html: string;
  try {
    html = (await upstream.fetch(PAGE_URL)).text();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return {
      entries: catalogue().map((s): Entry => ({ ...s, reading: { state: 'unreadable', why } })),
    };
  }
  return { entries: tokyoEntries(html) };
});
