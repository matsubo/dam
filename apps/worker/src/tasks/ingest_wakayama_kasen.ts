// apps/worker/src/tasks/ingest_wakayama_kasen.ts
//
// 和歌山県河川／雨量防災情報 ダム諸量 — 19 ダム hourly.
//
//   広川 / 二川 / 椿山 / 七川 / 切目川 / 殿山 / 小匠 /
//   猿谷 / 九尾 / 川迫 / 大滝 / 大迫 / 津風呂 /
//   坂本 / 池原 / 七色 / 二津野 / 小森 / 風屋
//
// Source:
//   http://kasensabo01.pref.wakayama.lg.jp/hyoujidata/dinfo.csv
//   (follows redirect to HTTPS)
//   Single CSV fetch; one row per dam; no header; EUC-JP encoded.
//
// CSV columns (from commonConfig.js csvDef.dinfo):
//   col[0] = 地点番号 (station code)
//   col[1] = 状態 (status)
//   col[2] = 放流量 [m³/s]
//   col[3] = 流入量 [m³/s]
//   col[4] = 貯水位 [m]
//   col[5] = 貯水量 [千m³] → storageVolumeM3 × 1000
//   col[6] = 観測時刻 "YYYYMMDDHHmm" JST
//   Missing values are encoded as "****".
//
// Priority 308. Cron hourly at :41.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.WAKAYAMA_KASEN_URL ?? 'http://kasensabo01.pref.wakayama.lg.jp/hyoujidata/dinfo.csv';

const SOURCE_ID = 'wakayama-kasen';

// Nara (29) and Mie (24) alongside Wakayama (30): the 22077xxx/22088xxx KKR
// dams in this source (猿谷/川迫/九尾/大滝/大迫/津風呂/坂本/池原/七色/二津野/小森/風屋)
// sit in the 熊野川/北山川 watershed spanning all three prefectures, so the
// universe carries no prefCode.
const PREFS = ['24', '29', '30'] as const;

// Station map from commonConfig.js DMCD_* constants.
// col[0] station code → dam name.
const STATION_MAP: Readonly<Record<string, string>> = {
  '450': '広川ダム',
  '470': '二川ダム',
  '550': '椿山ダム',
  '750': '七川ダム',
  '502': '切目川ダム',
  '601': '殿山ダム',
  '801': '小匠ダム',
  '22077001': '猿谷ダム',
  '22077002': '九尾ダム',
  '22077003': '川迫ダム',
  '22077006': '大滝ダム',
  '22077004': '大迫ダム',
  '22077005': '津風呂ダム',
  '22088001': '坂本ダム',
  '22088002': '池原ダム',
  '22088003': '七色ダム',
  '22088004': '二津野ダム',
  '22088005': '小森ダム',
  '22088006': '風屋ダム',
};

// --- parsing ----------------------------------------------------------------

/** "YYYYMMDDHHmm" (12 chars, JST) → UTC. Returns null on failure. */
export function parseWakayamaTimestamp(s: string): Date | null {
  if (s.length !== 12) return null;
  const yr = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const dy = Number(s.slice(6, 8));
  const hh = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  if ([yr, mo, dy, hh, mi].some(Number.isNaN)) return null;
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The CSV's own no-value marks. */
const MARKS = new Set(['****', '---', '--', '*']);

function field(s: string): Cell {
  const t = s.trim();
  if (MARKS.has(t)) return MARKED;
  return t ? cell(Number(t.replace(/,/g, '')), false) : null;
}

/** One CSV row's reading. */
export function wakayamaReading(cols: readonly string[]): Reading {
  if (cols.length < 7) return { state: 'unreadable', why: `${cols.length} columns` };
  const outflow = field(cols[2] ?? '');
  const inflow = field(cols[3] ?? '');
  const level = field(cols[4] ?? '');
  const volume = field(cols[5] ?? '');
  const state = cellState([outflow, inflow, level, volume]);
  if (state === 'empty') return { state, mark: '**** in every column' };
  if (state === 'unreadable') return { state, why: 'no readable value in the row' };
  const ts = (cols[6] ?? '').trim();
  const observedAt = parseWakayamaTimestamp(ts);
  if (!observedAt) return { state: 'unreadable', why: `観測時刻 "${ts}"` };
  const volThou = numberIn(volume);
  return {
    state,
    observations: [
      {
        observedAt,
        outflowM3s: numberIn(outflow),
        inflowM3s: numberIn(inflow),
        waterLevelM: numberIn(level),
        storageVolumeM3: volThou != null ? volThou * 1000 : null,
      },
    ],
  };
}

/**
 * Every station in STATION_MAP — a station blank this hour (小匠 is
 * flood-control-only and often reports nothing) is still published — plus
 * any row whose code the map lacks, keyed and named by its code.
 */
export function wakayamaEntries(text: string): Entry[] {
  const rows = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',');
    const code = (cols[0] ?? '').trim();
    if (code && !rows.has(code)) rows.set(code, cols);
  }
  const entry = (code: string, name: string): Entry => {
    const cols = rows.get(code);
    return {
      key: code,
      name,
      pref: PREFS,
      reading: cols ? wakayamaReading(cols) : { state: 'unreadable', why: 'not in the CSV' },
    };
  };
  const known = Object.entries(STATION_MAP).map(([code, name]) => entry(code, name));
  const unknown = [...rows.keys()].filter((c) => !STATION_MAP[c]).map((c) => entry(c, c));
  return [...known, ...unknown];
}

// --- task -------------------------------------------------------------------

async function fetchCsv(): Promise<string> {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return new TextDecoder('euc-jp').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async (log) => {
  let text: string;
  try {
    text = await fetchCsv();
  } catch (err) {
    // STATION_MAP is known in advance: record it unreadable rather than nothing.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return {
      entries: wakayamaEntries('').map(
        (e): Entry => ({ ...e, reading: { state: 'unreadable', why } }),
      ),
    };
  }
  const entries = wakayamaEntries(text);
  log(`${SOURCE_ID}: ${entries.length} stations`);
  return { entries };
});
