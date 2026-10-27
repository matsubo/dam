// apps/worker/src/tasks/ingest_miyazaki_bousai.ts
//
// 宮崎県河川・砂防水位観測所 ダム諸量現況表 — 防災Web HTML table, hourly.
//
//   13 県管理ダム: 祝子(祝子川) / 沖田(沖田川) / 松尾(小丸川) /
//   渡川(渡川) / 立花(三財川) / 長谷(三納川) / 岩瀬(岩瀬川) /
//   綾南(本庄川) / 田代八重(綾北川) / 綾北(綾北川) / 瓜田(瓜田川) /
//   日南(酒谷川) / 広渡(広渡川).
//
// Source:
//   http://kasen.pref.miyazaki.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus
//   ?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Format: Shift_JIS HTML table (no session required). 8 columns per row:
//   河川名 | 局名(dam) | 所在地 | 状態 | 最新観測時刻 |
//   貯水位[m] | 流入量[m³/s] | 全放流量[m³/s]
// Timestamp: "YYYY MM/DD HH:MM" JST.
// No 貯水量 or 貯水率 columns (storage values set null).
// Cell marks follow the same vendor servlet as kagoshima-kasen (*** 欠測,
// --- 無効, ### 範囲異常, blank 未入力); a dam marked in all three value
// columns is provider-marked empty.
// Priority 308, matching other 防災Web prefectural sources.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.MIYAZAKI_BOUSAI_URL ??
  'http://kasen.pref.miyazaki.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '45';
const SOURCE_ID = 'miyazaki-bousai';

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MARKS = new Set(['', '***', '---', '###']);

function parseNum(s: string): Cell {
  if (MARKS.has(s)) return cell(null, true);
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return cell(m ? Number(m[0]) : null, false);
}

/** "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseMiyazakiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\s+(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowReading(cells: string[]): Reading {
  const level = parseNum(cleanCell(cells[5] ?? ''));
  const inflow = parseNum(cleanCell(cells[6] ?? ''));
  const outflow = parseNum(cleanCell(cells[7] ?? ''));
  const state = cellState([level, inflow, outflow]);
  if (state === 'empty') return { state, mark: '***/---/###/blank in every value column' };
  if (state === 'unreadable') return { state, why: 'no numeric cell' };
  const ts = cleanCell(cells[4] ?? '');
  const observedAt = parseMiyazakiTimestamp(ts);
  if (!observedAt) return { state: 'unreadable', why: `最新観測時刻 "${ts}"` };
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * One entry per dam row of the 防災Web table (8 columns per data row). The
 * table carries no station id, so the published name is the key.
 */
export function miyazakiEntries(html: string): Entry[] {
  const out: Entry[] = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/gi);
  const dataTable = tableMatch?.[0] ?? '';

  const trList = Array.from(dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) => c[1] ?? ''),
  );

  for (const cells of trList) {
    if (cells.length < 8) continue;
    // Dam name at col 1 — filter out header/unit rows.
    const damName = cleanCell(cells[1] ?? '');
    if (!damName || (!damName.includes('ダム') && !damName.includes('貯水池'))) continue;
    // The master files a 貯水池 under its bare name (綾南貯水池 → 綾南).
    const bare = damName.replace(/貯水池$/, '');
    out.push({
      key: damName,
      name: damName,
      pref: PREF_CODE,
      ...(bare !== damName ? { bind: { name: bare } } : {}),
      reading: rowReading(cells),
    });
  }
  return out;
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(DATA_URL)).text('shift_jis');
  const entries = miyazakiEntries(html);
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
