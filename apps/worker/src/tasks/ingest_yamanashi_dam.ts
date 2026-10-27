// apps/worker/src/tasks/ingest_yamanashi_dam.ts
//
// 山梨県雨量・水位情報 ダム状況表 — 6 県管理ダム hourly.
//
//   大門 / 塩川 / 広瀬 / 琴川 / 荒川 / 深城
//
// Source:
//   http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam005.asp?pAu=2
//
//   The 「ダム状況表」 tab of the ダム情報 frames (dam001.asp → dammain.asp
//   ?pFrm=3). One Shift_JIS page lists every dam; the server ignores the
//   P1..P5 query the site's own links carry and always serves the latest hour.
//   Header: "YYYY年MM月DD日 HH時MM分 現在" (JST; "24時00分" = next-day 00:00).
//   Table columns:
//     [0] ダム名
//     [1] 貯水位    [EL.m]
//     [2] 貯水量    [千 m3]
//     [3] 空容量    [千 m3]
//     [4] 全流入量  [m³/s]
//     [5] 全放流量  [m³/s]
//     [6] ダム雨量 時間 [mm/h]
//     [7] ダム雨量 累計 [mm]
//
//   No 貯水率 is published, so storage_rate stays NULL and the 0036 trigger
//   derives it from volume / active_capacity_m3. 貯水量 + 空容量 is the page's
//   implied denominator; on 2026-09-27 it equalled the master 有効貯水容量 for
//   塩川 8,900 / 広瀬 11,350 / 琴川 4,750 / 荒川 8,600 千m³ (大門 2,159 vs
//   2,350, 深城 5,337 vs 5,140). The master is right for those two: the
//   dam offices' spec pages (pref.yamanashi.jp/dam-dmskkn/dam-profile.html,
//   /damu-fk/fukasiro_dam_toha.html) give 有効 2,350,000 / 5,140,000, and 空容量
//   runs to サーチャージ, not a seasonal level (大門 895.51 m, above its 常時満水位
//   894.50, still printed 1,042 空). The derived rate is therefore 有効-based, the
//   static denominator, and this source is not trusted_rate_basis (0048).
//
// Priority 280. Cron hourly at :36.

import { cell, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const STATUS_URL =
  process.env.YAMANASHI_DAM_URL ??
  'http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam005.asp?pAu=2';

const PREF_CODE = '19';
const SOURCE_ID = 'yamanashi-dam';

// --- dam config (code → display name) --------------------------------------

// The site's station codes (P3). ダム状況表 rows carry only the name; the
// code is the universe key and the stamp, as when each dam was fetched by
// code. The catalogue is the universe even when the page fails.
const DAMS: { code: string; name: string }[] = [
  { code: '5002', name: '大門ダム' },
  { code: '5001', name: '塩川ダム' },
  { code: '4001', name: '広瀬ダム' },
  { code: '4002', name: '琴川ダム' },
  { code: '1001', name: '荒川ダム' },
  { code: '8001', name: '深城ダム' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  yamanashiName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * First "YYYY年MM月DD日 HH時MM分" (JST) in `s` → UTC.
 * "24時00分" on date D is treated as D+1 00:00 JST.
 */
export function parseYamanashiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})年(\d{2})月(\d{2})日\s*(\d{2})時(\d{2})分/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const utcH = hh === 24 ? -9 : hh - 9;
  const extraDay = hh === 24 ? 1 : 0;
  const d = new Date(Date.UTC(yr, mo - 1, dy + extraDay, utcH, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const m = s.trim().match(/-?\d+(?:\.\d+)?/);
  return m ? numberIn(cell(Number(m[0]), false)) : null;
}

/**
 * Every dam row of the ダム状況表 (dam005.asp), stamped with the page's "現在"
 * time; null when the page carries no timestamp. If the 貯水量 column stops
 * saying [千 m3], volumes are dropped (and `warn` is called) rather than stored
 * at the wrong scale; the other fields are kept.
 */
export function parseYamanashiStatusHtml(
  html: string,
  warn: (s: string) => void,
): ParsedRow[] | null {
  const observedAt = parseYamanashiTimestamp(html);
  if (!observedAt) return null;
  const volumeInThousands = /貯水量\s*(?:<br>)?\s*\[千\s*m3\]/i.test(html);

  const rows: ParsedRow[] = [];
  for (const trMatch of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    const cells = [...(trMatch[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(
      (c) =>
        c[1]
          ?.replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim() ?? '',
    );
    // Data rows have 8 cells; the two header rows (rowspan / colspan) fewer.
    const name = cells[0];
    if (cells.length < 8 || !name) continue;

    const volumeThousandM3 = volumeInThousands ? parseNum(cells[2] ?? '') : null;
    rows.push({
      yamanashiName: name,
      observedAt,
      waterLevelM: parseNum(cells[1] ?? ''),
      storageVolumeM3: volumeThousandM3 === null ? null : Math.round(volumeThousandM3 * 1000),
      inflowM3s: parseNum(cells[4] ?? ''),
      outflowM3s: parseNum(cells[5] ?? ''),
      rainfallMm: parseNum(cells[6] ?? ''),
    });
  }

  if (rows.length > 0 && !volumeInThousands) {
    warn(`${SOURCE_ID}: 貯水量 column is no longer labelled [千 m3]; volumes dropped`);
  }
  return rows;
}

export function yamanashiReading(r: ParsedRow): Reading {
  const { yamanashiName: _, ...observed } = r;
  // The page shows no mark of its own: a row without a number is unreadable.
  if (
    [r.waterLevelM, r.storageVolumeM3, r.inflowM3s, r.outflowM3s, r.rainfallMm].every(
      (v) => v === null,
    )
  ) {
    return { state: 'unreadable', why: 'no number in the row' };
  }
  return { state: 'values', observations: [observed] };
}

function catalogue(reading: (name: string) => Reading): Entry[] {
  return DAMS.map((d) => ({
    key: d.code,
    name: d.name,
    pref: PREF_CODE,
    reading: reading(d.name),
  }));
}

/**
 * The catalogue, read from the page — a dam missing from it is unreadable —
 * plus any row the catalogue lacks, keyed by its printed name.
 */
export function yamanashiEntries(html: string, warn: (s: string) => void): Entry[] {
  const rows = parseYamanashiStatusHtml(html, warn);
  if (!rows) return catalogue(() => ({ state: 'unreadable', why: 'no 現在 timestamp' }));
  const byName = new Map(rows.map((r) => [r.yamanashiName, r]));
  const known = catalogue((name) => {
    const r = byName.get(name);
    return r ? yamanashiReading(r) : { state: 'unreadable', why: 'not on the page' };
  });
  const extra = rows
    .filter((r) => !DAMS.some((d) => d.name === r.yamanashiName))
    .map(
      (r): Entry => ({
        key: r.yamanashiName,
        name: r.yamanashiName,
        pref: PREF_CODE,
        reading: yamanashiReading(r),
      }),
    );
  return [...known, ...extra];
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  let html: string;
  try {
    html = (await upstream.fetch(STATUS_URL)).text('shift_jis');
  } catch (e) {
    // The catalogue is still recorded, as it was when per-dam fetches failed.
    const why = e instanceof Error ? e.message : String(e);
    log(`${SOURCE_ID}: fetch failed: ${why}`);
    return { entries: catalogue(() => ({ state: 'unreadable', why })) };
  }
  return { entries: yamanashiEntries(html, log) };
});
