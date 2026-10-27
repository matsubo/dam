// apps/worker/src/tasks/ingest_hrr_mlit.ts
//
// Twelfth real-observation source. 国土交通省 北陸地方整備局 publishes a
// consolidated dam dashboard at:
//   https://www.hrr.mlit.go.jp/river/dam-bousai/
// The map layer fetches `data/tmDam.txt` — a CSV-like file with one row
// per dam carrying the current 流入/放流/貯水位 values:
//
//   大川ダム,21527,00001,37.3463...,139.9119...,2026/05/19,05:00,12.87,20.06,372.52,-,-,1,0
//
// Columns: name, area_cd, dam_cd, lat, lng, date, time, inflow_m3s,
//          outflow_m3s, water_level_m, ?, ?, icon_cd, status
//
// 7 dams across 6 prefectures (福島/山形/新潟/長野/富山/石川):
//   大川 / 大石 / 横川 / 三国川 / 大町 / 宇奈月 / 手取川
//
// The file is the published list: every row is a universe entry, keyed by its
// name, so a dam 北陸地整 adds shows up as an unmatched row instead of
// vanishing. "-" (or 欠測) in all three value columns is provider-marked empty.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const CSV_URL =
  process.env.HRR_MLIT_DAM_URL ?? 'https://www.hrr.mlit.go.jp/river/dam-bousai/data/tmDam.txt';

/** Prefecture of each configured dam; a row not listed here has none to search. */
const PREF_BY_NAME: Record<string, string> = {
  大川ダム: '07',
  大石ダム: '15',
  横川ダム: '06',
  三国川ダム: '15',
  大町ダム: '20',
  宇奈月ダム: '16',
  手取川ダム: '17',
};

const SOURCE_ID = 'hrr-mlit-dam';

function parseCell(s: string | undefined): Cell {
  const t = (s ?? '').replace(/[,\s　]/g, '');
  if (t === '-' || t === '−' || t === '欠測') return MARKED;
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** One CSV row's reading (columns as in the header comment). */
export function hrrReading(cols: readonly string[]): Reading {
  const dMatch = (cols[5] ?? '').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  const tMatch = (cols[6] ?? '').match(/(\d{1,2}):(\d{1,2})/);
  if (!dMatch || !tMatch) {
    return { state: 'unreadable', why: `date/time "${cols[5]} ${cols[6]}"` };
  }
  const observedAt = new Date(
    Date.UTC(
      Number(dMatch[1]),
      Number(dMatch[2]) - 1,
      Number(dMatch[3]),
      Number(tMatch[1]) - 9,
      Number(tMatch[2]),
      0,
      0,
    ),
  );
  const inflow = parseCell(cols[7]);
  const outflow = parseCell(cols[8]);
  const level = parseCell(cols[9]);
  const state = cellState([inflow, outflow, level]);
  if (state === 'empty') return { state, mark: '- in every value column' };
  if (state === 'unreadable') return { state, why: 'no numeric value column' };
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        waterLevelM: numberIn(level),
      },
    ],
  };
}

/** Every named row of tmDam.txt; blank and short lines are not rows. */
export function hrrEntries(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split(',').map((c) => c.trim());
    const name = cols[0] ?? '';
    if (cols.length < 10 || !name) continue;
    entries.push({
      key: name,
      name,
      pref: PREF_BY_NAME[name] ?? null,
      lat: Number(cols[3]) || null,
      lng: Number(cols[4]) || null,
      reading: hrrReading(cols),
    });
  }
  return entries;
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = hrrEntries((await upstream.fetch(CSV_URL, { timeoutMs: 12_000 })).text());
  log(`${SOURCE_ID}: ${entries.length} rows`);
  return { entries };
});
