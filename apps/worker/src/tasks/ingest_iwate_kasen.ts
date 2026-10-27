// apps/worker/src/tasks/ingest_iwate_kasen.ts
//
// 岩手県河川情報システム ダム諸量経過表 — 防災Web-style servlet, hourly.
//
//   10 県管理ダム: 綱取(中津川) / 簗川(簗川) / 滝(長内川) /
//   入畑(夏油川) / 日向(小川川) / 早池峰(稗貫川) /
//   綾里川(綾里川) / 鷹生(鷹生川) / 遠野(来内川) / 遠野第二(来内川).
//
// Source:
//   http://kasen.pref.iwate.jp/iwate/servlet/Gamen32Servlet?param=station=N
//   One request per station (N=0..9); the server returns Shift_JIS HTML with
//   the most recent 24-hour time-series for that dam.
// Format: Shift_JIS HTML, `<div class="dat2">` cells per column:
//   [0] 貯水位(ELm) [1] 貯水量(千m³) [2] 空容量(千m³)
//   [3] 全流入量(m³/s) [4] ゲート放流量 [5] 使用水量
//   [6] 全放流量(m³/s) [7] 調整流量
// Timestamp: "<td class=\"ListDate\">MM/DD&nbsp;HH:MM</td>" JST; year from
//   commonParam "dispDate:YYYY-MM-DD-HH-MM" embedded in the response HTML.
// "-", "―", "欠測" and "c" (調整中) are the server's own marks.
// Priority 308, matching other prefectural sources.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const BASE_URL =
  process.env.IWATE_KASEN_URL ?? 'http://kasen.pref.iwate.jp/iwate/servlet/Gamen32Servlet';

const PREF_CODE = '03';
const SOURCE_ID = 'iwate-kasen';

// Station index → (stationNo, dam name).  Index matches the server's dropdown
// order; stationNo is the key (universe and stamp). The server writes
// 「遠野第二ダム」 where ダム便覧 has 「遠野第2」; bind.ts folds the ordinal.
interface StationCfg {
  readonly idx: number;
  readonly stationNo: string;
  readonly name: string;
}

const STATIONS: StationCfg[] = [
  { idx: 0, stationNo: '103007003', name: '綱取ダム' },
  { idx: 1, stationNo: '103007002', name: '簗川ダム' },
  { idx: 2, stationNo: '103007001', name: '滝ダム' },
  { idx: 3, stationNo: '103007011', name: '入畑ダム' },
  { idx: 4, stationNo: '103007004', name: '日向ダム' },
  { idx: 5, stationNo: '103007008', name: '早池峰ダム' },
  { idx: 6, stationNo: '103007006', name: '綾里川ダム' },
  { idx: 7, stationNo: '103007005', name: '鷹生ダム' },
  { idx: 8, stationNo: '103007012', name: '遠野ダム' },
  { idx: 9, stationNo: '103007016', name: '遠野第二ダム' },
];

// --- parsing ----------------------------------------------------------------

function valueCell(s: string): Cell {
  const t = s.replace(/[,\s　]/g, '');
  if (t === '-' || t === '―' || t === '欠測' || t === 'c') return MARKED;
  return cell(t ? Number(t) : null, false);
}

/** Extract year from the embedded commonParam "dispDate:YYYY-MM-DD-HH-MM$..." */
export function extractYear(html: string): number {
  const m = html.match(/var commonParam = "[^"]*dispDate:(\d{4})/);
  return m ? Number(m[1]) : new Date().getUTCFullYear();
}

/** "MM/DD HH:MM" JST + year → UTC Date */
export function parseIwateTimestamp(rowDate: string, year: number): Date | null {
  const m = rowDate.match(/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hr = Number(m[3]);
  const mi = Number(m[4]);
  const d = new Date(Date.UTC(year, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * One dam page's reading: its most recent row. Finds the first ListDate
 * cell, then collects the next 8 dat2 values.
 */
export function iwateReading(html: string): Reading {
  const year = extractYear(html);

  // First ListDate cell → timestamp
  const dateMatch = html.match(/<td[^>]+class="ListDate"[^>]*>([\s\S]*?)<\/td>/);
  if (!dateMatch) return { state: 'unreadable', why: 'no ListDate cell' };
  const rawDate = (dateMatch[1] ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

  // dat2 values after the first ListDate cell position
  const startPos = html.indexOf(dateMatch[0]) + dateMatch[0].length;
  const dat2Re = /<div class="dat2"><span[^>]*>([\s\S]*?)<\/span><\/div>/g;
  dat2Re.lastIndex = startPos;
  const vals: Cell[] = [];
  for (let i = 0; i < 8; i++) {
    const hit = dat2Re.exec(html);
    if (!hit) break;
    vals.push(valueCell((hit[1] ?? '').trim()));
  }

  // [0] 貯水位 [1] 貯水量 千m³ [3] 全流入量 [6] 全放流量
  const [level, storageThou, inflow, outflow] = [0, 1, 3, 6].map((i) => vals[i] ?? null) as [
    Cell,
    Cell,
    Cell,
    Cell,
  ];
  const state = cellState([level, storageThou, inflow, outflow]);
  if (state === 'empty') return { state, mark: '"c" / "-" / "欠測" in every column' };
  if (state === 'unreadable') return { state, why: 'no numeric value' };
  const observedAt = parseIwateTimestamp(rawDate, year);
  if (!observedAt) return { state: 'unreadable', why: `ListDate "${rawDate}"` };
  const thou = numberIn(storageThou);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** One station's page, by its dropdown index. */
export const pageUrl = (idx: number): string => `${BASE_URL}?param=station=${idx}`;

/**
 * The 10-station catalogue, keyed by stationNo; each dam reads its own page,
 * and a page that fails leaves only that dam unreadable.
 */
export function iwateEntries(upstream: Upstream): Entry[] {
  return STATIONS.map((stn) => ({
    key: stn.stationNo,
    name: stn.name,
    pref: PREF_CODE,
    reading: async () => iwateReading((await upstream.fetch(pageUrl(stn.idx))).text('shift_jis')),
  }));
}

export default ingestTask(SOURCE_ID, async ({ upstream }) => ({
  entries: iwateEntries(upstream),
}));
