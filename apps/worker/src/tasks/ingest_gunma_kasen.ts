// apps/worker/src/tasks/ingest_gunma_kasen.ts
//
// 群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly.
//
//   坂本ダム / 霧積ダム / 塩沢ダム / 四万川ダム /
//   道平川ダム / 大仁田ダム / 桐生川ダム
//
// Source:
//   https://www.river-gunma.jp/gunmaT/m4101/60/_0_{idx}_0.html
//   One Shift_JIS HTML page per station; indices 1–7.
//   Labels and values in <TD> pairs; dam name in <DIV align="center">;
//   timestamp in "MM月DD日HH時mm分現在" text (JST, no year).
//   Storage volume in 千m³; values may have → / ↑ / ↓ change arrows.
//   "-", "---", "***", "****" are the page's own blanks.
//
// Priority 308. Cron hourly at :48.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL =
  process.env.GUNMA_KASEN_BASE_URL ?? 'https://www.river-gunma.jp/gunmaT/m4101/60/_0_{idx}_0.html';

const PREF_CODE = '10';
const SOURCE_ID = 'gunma-kasen';

// Station indices 1–7 with names confirmed from live pages. Keyed by the
// published name, not the page index: `idx` is a positional URL slot
// (_0_{idx}_0.html) that would silently re-point if the site reordered its
// pages.
const STATIONS: ReadonlyArray<{ idx: number; name: string }> = [
  { idx: 1, name: '坂本ダム' },
  { idx: 2, name: '霧積ダム' },
  { idx: 3, name: '塩沢ダム' },
  { idx: 4, name: '四万川ダム' },
  { idx: 5, name: '道平川ダム' },
  { idx: 6, name: '大仁田ダム' },
  { idx: 7, name: '桐生川ダム' },
];

// --- parsing ----------------------------------------------------------------

/**
 * "MM月DD日HH時mm分現在" (JST, no year) → UTC.
 * Year is inferred from the current date; if the resulting datetime is more
 * than 24 hours in the future, the previous calendar year is used instead.
 */
export function parseGunmaTimestamp(s: string, now: Date = new Date()): Date | null {
  const m = s.match(/(\d{1,2})月(\d{1,2})日(\d{2})時(\d{2})分/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hh = Number(m[3]);
  const mi = Number(m[4]);
  if ([mo, dy, hh, mi].some(Number.isNaN)) return null;

  const yr = now.getFullYear();
  let d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  if (d.getTime() > now.getTime() + 86_400_000) {
    d = new Date(Date.UTC(yr - 1, mo - 1, dy, hh - 9, mi, 0, 0));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value: "-", "---", "***", "****" are the page's own marks. */
function valueCell(s: string): Cell {
  const t = s
    .replace(/[→↑↓←]/g, '')
    .replace(/,/g, '')
    .trim();
  if (t === '-' || t === '---' || t === '***' || t === '****') return MARKED;
  return cell(t ? Number(t) : null, false);
}

/** Read a Gunma ダム現況表 Shift_JIS HTML page (already decoded to UTF-8 string). */
export function gunmaReading(html: string, now: Date = new Date()): Reading {
  // Extract timestamp from "MM月DD日HH時mm分現在" pattern
  const tsMatch = html.match(/(\d{1,2}月\d{1,2}日\d{2}時\d{2}分現在)/);
  const observedAt = tsMatch?.[1] ? parseGunmaTimestamp(tsMatch[1], now) : null;

  // Extract label→value pairs from <TD> rows
  const cells = Array.from(html.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((c) =>
    (c[1] ?? '').replace(/<[^>]+>/g, '').trim(),
  );

  // Only the labels the page prints: a dam without a 貯水量 row is not unreadable for it.
  let level: Cell | undefined;
  let storageThou: Cell | undefined;
  let inflow: Cell | undefined;
  let outflow: Cell | undefined;
  for (let i = 0; i < cells.length - 1; i++) {
    const label = cells[i] ?? '';
    const value = cells[i + 1] ?? '';
    if (label.includes('貯水位')) level = valueCell(value);
    else if (label.includes('貯水量')) storageThou = valueCell(value);
    else if (label.includes('流入量')) inflow = valueCell(value);
    else if (label.includes('放流量')) outflow = valueCell(value);
  }

  const state = cellState(
    [level, storageThou, inflow, outflow].filter((c): c is Cell => c !== undefined),
  );
  if (state === 'empty') return { state, mark: '"-" / "****" in every value' };
  if (state === 'unreadable') return { state, why: 'no numeric value' };
  if (!observedAt) return { state: 'unreadable', why: 'no "MM月DD日HH時mm分現在" on the page' };
  const thou = numberIn(storageThou ?? null);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level ?? null),
        storageVolumeM3: thou != null ? thou * 1000 : null,
        inflowM3s: numberIn(inflow ?? null),
        outflowM3s: numberIn(outflow ?? null),
      },
    ],
  };
}

/** One station's page, by its index. */
export const pageUrl = (idx: number): string => BASE_URL.replace('{idx}', String(idx));

/**
 * The provider's whole catalogue; each dam reads its own page, and a page
 * that fails leaves only that dam unreadable.
 */
export function gunmaEntries(upstream: Upstream): Entry[] {
  return STATIONS.map(({ idx, name }) => ({
    key: name,
    name,
    pref: PREF_CODE,
    reading: async () => gunmaReading((await upstream.fetch(pageUrl(idx))).text('shift_jis')),
  }));
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: gunmaEntries(upstream),
}));
