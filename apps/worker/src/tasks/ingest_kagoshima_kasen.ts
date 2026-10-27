// apps/worker/src/tasks/ingest_kagoshima_kasen.ts
//
// 鹿児島県河川砂防情報システム ダム一覧表 (全県) — 3 県管理ダム, 10-minute values.
//
//   西之谷 (鹿児島市, 治水専用) / 川辺 (南九州市) / 大和 (大島郡大和村)
//
// Source:
//   https://www3.doboku-bousai.pref.kagoshima.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4
//   (the ダム → 一覧表 page of index.jsp; Shift_JIS HTML, no session needed)
//
// Unlike ingest_kagoshima_bousai (防災ポータル dam_station.json, populated only
// during flood events), this table is published continuously.
//
// Columns per dam row (10 <td>):
//   局名 | 所在地 | 最新観測時刻 "YYYY/MM/DD&nbsp;HH:MM" (JST) |
//   貯水位[EL.m] | 貯水量[10³m³] | 全流入量[m³/s] | 全放流量[m³/s] |
//   空容量[10³m³] | 貯水率（治水）[%] | 貯水率（利水）[%]
// Values carry a trend arrow entity (&rarr; &uarr; &darr;). Legend markers:
// *** 欠測, --- 無効, ### 範囲異常, blank 未入力 — the table's own marks; a dam
// marked in every column it is read for is provider-marked empty.
//
// Rate: 貯水率（利水） only. Back-solved from the servlet's own history
// (tm=…, 2026-04 … 2026-09) against the master:
//   利水  川辺 587/88.9 % = 660, 650/98.5 % = 660 千m³ (annual 有効 2,460)
//         大和 172/84.2 % = 204, 199/97.7 % = 204 千m³ (annual 有効 721)
//   治水  大和 199/27.7 % = 718, 214/29.7 % = 721 千m³ = 有効貯水容量
// So 利水 divides by the 利水 pool, and 治水 by the same static 有効 figure the
// site already uses. 西之谷 publishes only 治水; it is stored with a NULL rate
// rather than mixing a second denominator into a trusted source. 利水 is
// clamped at 100.0 once the level passes 常時満水位.
//
// Priority 309 — one above kagoshima-bousai (308), which covers the same 3
// dams but only during flood events. With equal priorities the chart's
// source (windowSource()) falls to the source_id tie-break, so it would not
// be the continuous, trusted 利水 series; that series should keep winning.
// Cron hourly at :52.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KAGOSHIMA_KASEN_DAM_URL ??
  'https://www3.doboku-bousai.pref.kagoshima.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREF_CODE = '46';
const SOURCE_ID = 'kagoshima-kasen';

// --- parsing ----------------------------------------------------------------

/** Cell text → number; markers (***, ---, ###) and blanks are the table's own mark. */
function cellValue(td: string | undefined): Cell {
  const text = (td ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
  if (text === '' || text === '***' || text === '---' || text === '###') return cell(null, true);
  return cell(Number(text), false);
}

/** "YYYY/MM/DD&nbsp;HH:MM" JST → UTC Date */
function parseJst(cell: string | undefined): Date | null {
  const m = (cell ?? '').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:&nbsp;|\s)+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function rowReading(cells: (string | undefined)[]): Reading {
  const level = cellValue(cells[3]);
  const volume = cellValue(cells[4]);
  const inflow = cellValue(cells[5]);
  const outflow = cellValue(cells[6]);
  // 貯水率（利水） only; see the header for why 治水 is not read.
  const rate = cellValue(cells[9]);
  const state = cellState([level, volume, inflow, outflow, rate]);
  if (state === 'empty') return { state, mark: '***/---/###/blank in every column' };
  if (state === 'unreadable') return { state, why: 'no numeric cell' };
  const observedAt = parseJst(cells[2]);
  if (!observedAt) return { state: 'unreadable', why: 'no 最新観測時刻' };
  const vol = numberIn(volume);
  const ratePct = numberIn(rate);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: vol === null ? null : vol * 1_000,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageRate: ratePct === null ? null : ratePct / 100,
      },
    ],
  };
}

/**
 * Every dam row of the 一覧表, whatever it currently reports, keyed by 局名
 * as published ("川辺ダム", the stamp this source has always used).
 */
export function kagoshimaKasenEntries(html: string): Entry[] {
  const out: Entry[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 10) continue;
    const name = cells[0]?.match(/<a[^>]*>([^<]+)<\/a>/i)?.[1]?.trim();
    if (!name) continue;
    out.push({ key: name, name, pref: PREF_CODE, reading: rowReading(cells) });
  }
  return out;
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(DATA_URL)).text('shift_jis');
  const entries = kagoshimaKasenEntries(html);
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
