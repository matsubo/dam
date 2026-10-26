// apps/worker/src/tasks/ingest_saitama_suibo.ts
//
// 埼玉県 川の防災情報 ダム諸量 — 9 ダム hourly.
//
//   合角ダム / 有間ダム / 権現堂調節池 (県管理) /
//   渡良瀬遊水地 / 二瀬ダム / 荒川第一調節池 /
//   浦山ダム / 滝沢ダム / 下久保ダム (国管理)
//
// Source:
//   https://suibo-river.pref.saitama.lg.jp/hyoujidata/dinfo.csv
//   UTF-8 CSV; one row per dam; no header.
//
// CSV columns (from commonConfig.js csvDef.dinfo):
//   col[0] = 地点番号 (station code)
//   col[1] = 状態 (status)
//   col[2] = 放流量 [m³/s]
//   col[3] = 流入量 [m³/s]
//   col[4] = 貯水位 [EL.m]
//   col[5] = 貯水量 [千m³] → storageVolumeM3 × 1000
//   col[6] = 貯水率 [%]
//   col[7] = 観測時刻 "YYYYMMDDHHmm" JST
//   col[8] = 管轄事務所名
//   Missing values encoded as "c", "*", empty — the portal's own mark.
//   Volume column uses comma-formatted numbers (e.g. "4,518").
//
// The station map below is the universe: a mapped station whose row is
// missing from the CSV is unreadable.
//
// Priority 308. Cron hourly at :44.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.SAITAMA_SUIBO_URL ?? 'https://suibo-river.pref.saitama.lg.jp/hyoujidata/dinfo.csv';

const PREF_CODE = '11';
const SOURCE_ID = 'saitama-suibo';
/**
 * 渡良瀬遊水地 and 下久保ダム sit on the prefecture's border and the master
 * files both under 群馬 (10), so their lookup also covers the neighbours
 * 栃木/群馬/東京; every other station is a 埼玉 dam.
 */
const BORDER_SCOPE: readonly string[] = [PREF_CODE, '09', '10', '13'];
const BORDER = new Set(['12330100001', '12331400006']);

// Station map from chitenconfig/DamList.csv
const STATION_MAP: Readonly<Record<string, string>> = {
  '55301100001': '合角ダム',
  '55301100002': '有間ダム',
  '55301100003': '権現堂調節池',
  '12330100001': '渡良瀬遊水地',
  '12331600001': '二瀬ダム',
  '12330800004': '荒川第一調節池',
  '12330800005': '浦山ダム',
  '12330800006': '滝沢ダム',
  '12331400006': '下久保ダム',
};

/**
 * Published names the master files under another name. 荒川第一調節池 is the
 * one built basin of MLIT's 荒川調節池; kasenbosai's station of the same name
 * is bound to that row and reports identical values.
 */
const MASTER_NAME: Readonly<Record<string, string>> = { 荒川第一調節池: '荒川調節池' };

// --- parsing ----------------------------------------------------------------

/** "YYYYMMDDHHmm" (12 chars, JST) → UTC. Returns null on failure. */
export function parseSaitamaTimestamp(s: string): Date | null {
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

const MARKS = new Set(['', 'c', '*', '****', '---']);

function parseVal(s: string): Cell {
  const t = s.trim();
  if (MARKS.has(t)) return cell(null, true);
  return cell(Number(t.replace(/,/g, '')), false);
}

/** Split one CSV line respecting RFC 4180 quoting. */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function rowReading(cols: string[]): Reading {
  const outflow = parseVal(cols[2] ?? '');
  const inflow = parseVal(cols[3] ?? '');
  const level = parseVal(cols[4] ?? '');
  const volThou = parseVal(cols[5] ?? '');
  const state = cellState([outflow, inflow, level, volThou]);
  if (state === 'empty') return { state, mark: 'c / * / blank in every column' };
  if (state === 'unreadable') return { state, why: 'no numeric cell' };
  const ts = (cols[7] ?? '').trim();
  const observedAt = parseSaitamaTimestamp(ts);
  if (!observedAt) return { state: 'unreadable', why: `観測時刻 "${ts}"` };
  const vol = numberIn(volThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        outflowM3s: numberIn(outflow),
        inflowM3s: numberIn(inflow),
        waterLevelM: numberIn(level),
        storageVolumeM3: vol != null ? vol * 1000 : null,
      },
    ],
  };
}

/** One entry per mapped station, keyed by 地点番号; rows for unmapped codes are ignored. */
export function saitamaEntries(text: string): Entry[] {
  const rows = new Map<string, string[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = splitCsvLine(line);
    if (cols.length < 8) continue;
    rows.set((cols[0] ?? '').trim(), cols);
  }
  return Object.entries(STATION_MAP).map(([code, name]): Entry => {
    const cols = rows.get(code);
    const masterName = MASTER_NAME[name];
    return {
      key: code,
      name,
      pref: BORDER.has(code) ? BORDER_SCOPE : PREF_CODE,
      ...(masterName ? { bind: { name: masterName } } : {}),
      reading: cols ? rowReading(cols) : { state: 'unreadable', why: 'not in dinfo.csv' },
    };
  });
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status}`);
  const entries = saitamaEntries(await r.text());
  log(`${SOURCE_ID}: ${entries.length} stations`);
  return { entries };
});
