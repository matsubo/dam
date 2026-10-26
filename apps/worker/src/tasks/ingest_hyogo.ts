// apps/worker/src/tasks/ingest_hyogo.ts
//
// Phase B4 (#8): 兵庫県 ダム諸量 — official BODIK open-data CSV.
//
// Source: data.bodik.jp dataset 280003_dam_hyogo, a single CSV refreshed
// every 10 minutes under a CC-BY 4.0 licence — the cleanest kind of source.
//
//   局番号,観測所名,観測時刻,貯水位[m],貯水位フラグ,貯水量[1000m3],貯水量フラグ,
//   全流入量[m3/s],全流入量フラグ,全放流量[m3/s],全放流量フラグ
//
// A value is valid only when its companion flag is "0" (160 = missing).
// 貯水量 is in 千m³ → ×1000 for m³. 22 stations (incl. a 分水堰 weir, which
// is recorded but is not one master dam). Cron hourly at :25.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const CSV_URL =
  process.env.HYOGO_DAM_CSV ??
  'https://data.bodik.jp/dataset/d854dd8e-0bf8-4821-8bc2-88108c32156f/resource/eaabaacb-97fb-451a-b0b8-10e2ece3f90c/download/tm-dam.csv';
const PREF_CODE = '28';
const SOURCE_ID = 'hyogo-bodik';
/** The one listed station that is a weir, not a dam. */
const WEIR = '分水堰';

/** Parse 「YYYY/MM/DD HH:MM」 (JST) → UTC Date. */
function parseStamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** A value is trustworthy only when its companion flag is "0". */
function gated(value: string, flag: string): Cell {
  const t = value.trim();
  return cell(t ? Number(t) : null, flag.trim() !== '0');
}

function rowReading(c: string[]): Reading {
  const level = gated(c[3] ?? '', c[4] ?? '');
  const volThou = gated(c[5] ?? '', c[6] ?? '');
  const inflow = gated(c[7] ?? '', c[8] ?? '');
  const outflow = gated(c[9] ?? '', c[10] ?? '');
  const state = cellState([level, volThou, inflow, outflow]);
  if (state === 'empty') return { state, mark: 'flag ≠ 0 on every field' };
  if (state === 'unreadable') return { state, why: 'no flag-0 value' };
  const observedAt = parseStamp(c[2] ?? '');
  if (!observedAt) return { state: 'unreadable', why: `観測時刻 "${c[2]}"` };
  const vol = numberIn(volThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: vol != null ? vol * 1_000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * Parse the BODIK dam CSV: one entry per station row, keyed by 観測所名 (the
 * stamp this source has always used). Skips the header and nameless rows.
 */
export function hyogoEntries(csv: string): Entry[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: Entry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c.length < 11) continue;
    if (c[0]?.trim() === '局番号') continue; // header
    const name = (c[1] ?? '').trim();
    if (!name) continue;
    out.push({
      key: name,
      name,
      pref: PREF_CODE,
      ...(name === WEIR ? { bind: 'never' as const } : {}),
      reading: rowReading(c),
    });
  }
  return out;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const res = await fetch(CSV_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${res.status}`);
  const entries = hyogoEntries(await res.text());
  log(`${SOURCE_ID}: ${entries.length} stations`);
  return { entries };
});
