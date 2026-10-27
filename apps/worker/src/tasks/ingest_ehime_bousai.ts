// apps/worker/src/tasks/ingest_ehime_bousai.ts
//
// 愛媛県 河川・砂防情報システム — ダム諸量経過表, 12 dams, hourly.
//
// Source:
//   http://183.176.244.72/kawabou-mng/customizeMyMenuKeika.do
//     ?GID=05-5101&userId=U1001&myMenuId=U1001_MMENU00X
//   (UTF-8 HTML; 24-hour hourly table per dam; publicly accessible)
//
// Dams (from MenuConfig.json grpid_value):
//   MMENU001 鹿森ダム    MMENU002 黒瀬ダム    MMENU003 玉川ダム
//   MMENU004 台ダム      MMENU005 須賀川ダム  MMENU006 山財ダム
//   MMENU007 柳瀬ダム(国) MMENU008 石手川ダム(国) MMENU009 鹿野川ダム(国)
//   MMENU010 野村ダム(国) MMENU011 新宮ダム(国)   MMENU012 富郷ダム(国)
//
// Table 1 (data) columns: [timestamp, waterLevel(m), inflow(m³/s),
//   outflow(m³/s), storage(1000m³), storageRate(%) ]
// Timestamp: first col is "MM/DD HH:MM" at date changes, "HH:MM" otherwise.
//   "24:00" = midnight of the NEXT calendar day.
// "-" / "---" are the page's own blanks (storageRate is "-" for national dams);
// a latest row with nothing but those is provider-marked empty.
//
// Priority 308. Cron hourly at :57.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL =
  process.env.EHIME_BOUSAI_URL ??
  'http://183.176.244.72/kawabou-mng/customizeMyMenuKeika.do?GID=05-5101&userId=U1001';

const PREF_CODE = '38';
const SOURCE_ID = 'ehime-bousai';

const DAMS = [
  { myMenuId: 'U1001_MMENU001', name: '鹿森ダム' },
  { myMenuId: 'U1001_MMENU002', name: '黒瀬ダム' },
  { myMenuId: 'U1001_MMENU003', name: '玉川ダム' },
  { myMenuId: 'U1001_MMENU004', name: '台ダム' },
  { myMenuId: 'U1001_MMENU005', name: '須賀川ダム' },
  { myMenuId: 'U1001_MMENU006', name: '山財ダム' },
  { myMenuId: 'U1001_MMENU007', name: '柳瀬ダム' },
  { myMenuId: 'U1001_MMENU008', name: '石手川ダム' },
  { myMenuId: 'U1001_MMENU009', name: '鹿野川ダム' },
  { myMenuId: 'U1001_MMENU010', name: '野村ダム' },
  { myMenuId: 'U1001_MMENU011', name: '新宮ダム' },
  { myMenuId: 'U1001_MMENU012', name: '富郷ダム' },
] as const;

// --- parsing -----------------------------------------------------------------

/** A value cell: "-" / "---" are the page's own marks. */
function valueCell(s: string): Cell {
  if (s === '-' || s === '---') return MARKED;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return cell(m ? Number(m[0]) : null, false);
}

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const tableM of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows: string[][] = [];
    for (const rowM of (tableM[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = Array.from((rowM[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi), (c) =>
        cleanText(c[1] ?? ''),
      );
      rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

/**
 * Parse Ehime date-tracking timestamp.
 * Returns the observation Date (UTC) and the updated running date context.
 * Handles "MM/DD HH:MM" (full date), "HH:MM" (time only), and "24:00" (midnight+1).
 */
export function parseEhimeTimestamp(
  tsCell: string,
  ctx: { year: number; month: number; day: number },
): { date: Date | null; ctx: { year: number; month: number; day: number } } {
  // Full date: "MM/DD HH:MM"
  const fullM = tsCell.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (fullM) {
    const [, moS, dyS, hrS, miS] = fullM;
    const mo = +(moS ?? 0);
    const dy = +(dyS ?? 0);
    const hr = +(hrS ?? 0);
    const mi = +(miS ?? 0);
    const d = new Date(Date.UTC(ctx.year, mo - 1, dy, hr - 9, mi));
    return {
      date: Number.isNaN(d.getTime()) ? null : d,
      ctx: { year: ctx.year, month: mo, day: dy },
    };
  }

  // Time only: "HH:MM" or "24:00"
  const timeM = tsCell.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeM) return { date: null, ctx };

  const [, hrS, miS] = timeM;
  let hr = +(hrS ?? 0);
  const mi = +(miS ?? 0);
  let { year, month, day } = ctx;

  if (hr === 24) {
    // "24:00" = 00:00 of the next calendar day
    hr = 0;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  const d = new Date(Date.UTC(year, month - 1, day, hr - 9, mi));
  return { date: Number.isNaN(d.getTime()) ? null : d, ctx: { year, month, day } };
}

/**
 * One dam page's reading: its latest (last) hourly row. `now` seeds the
 * date context for rows that print only "HH:MM" before the first full date.
 */
export function ehimeReading(html: string, now: Date = new Date()): Reading {
  const tables = extractTables(html);
  // Table 0: meta (観測所名, 水系名, …)
  // Table 1: 24-row hourly data
  const dataRows = tables[1];
  if (!dataRows || dataRows.length === 0) return { state: 'unreadable', why: 'no data table' };

  // The 24-hour window starts ~24h before now, so start from "yesterday" (JST).
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  const yesterday = new Date(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate() - 1),
  );
  let ctx = {
    year: yesterday.getUTCFullYear(),
    month: yesterday.getUTCMonth() + 1,
    day: yesterday.getUTCDate(),
  };

  // Process all rows, tracking dates; keep the last dated one
  let last: { observedAt: Date; row: string[] } | null = null;
  for (const row of dataRows) {
    if (row.length < 5) continue;
    const { date, ctx: newCtx } = parseEhimeTimestamp(row[0] ?? '', ctx);
    ctx = newCtx;
    if (date) last = { observedAt: date, row };
  }
  if (!last) return { state: 'unreadable', why: 'no dated row' };

  const { observedAt, row } = last;
  const [level, inflow, outflow, volume, rate] = [1, 2, 3, 4, 5].map((i) =>
    valueCell(row[i] ?? ''),
  ) as [Cell, Cell, Cell, Cell, Cell];
  const state = cellState([level, inflow, outflow, volume, rate]);
  if (state === 'empty') return { state, mark: '"-" in every column of the latest row' };
  if (state === 'unreadable') return { state, why: 'no numeric value in the latest row' };
  const v = numberIn(volume);
  const ratePct = numberIn(rate);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageVolumeM3: v !== null ? v * 1_000 : null,
        storageRate: ratePct !== null ? ratePct / 100 : null,
      },
    ],
  };
}

/** One dam's page, by myMenuId. */
export const pageUrl = (myMenuId: string): string => `${BASE_URL}&myMenuId=${myMenuId}`;

/**
 * The 12-dam catalogue, keyed by myMenuId; each dam reads its own page, and a
 * page that fails leaves only that dam unreadable.
 */
export function ehimeEntries(upstream: Upstream): Entry[] {
  return DAMS.map(({ myMenuId, name }) => ({
    key: myMenuId,
    name,
    pref: PREF_CODE,
    reading: async () => ehimeReading((await upstream.fetch(pageUrl(myMenuId))).text()),
  }));
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: ehimeEntries(upstream),
}));
