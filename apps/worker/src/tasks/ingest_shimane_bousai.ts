// apps/worker/src/tasks/ingest_shimane_bousai.ts
//
// 島根県水防情報システム (suibou-shimane.jp) ダム諸量 — 19 ダム, hourly.
//
//   県管理 (14): 布部/山佐/三瓶/波積/八戸/浜田/第二浜田/大長見/御部/益田川/
//                笹倉/大峠/銚子/美田
//   追加 (5):   嵯峨谷/津田川/清瀧/三成/木都賀 (station 600-604)
//
// Note: 国直轄 (尾原/志津見) are already covered by cgr-mlit-dam (priority 304),
// which wins preferredSource for those dams via lower priority number.
//
// Source URL:
//   https://www.suibou-shimane.jp/dyn/dps/json/YYYYMMDD/dam60.json  (JST date)
//   One file per JST day holding every hourly snapshot so far (00-00 … 23-00)
//   plus "update". Rewritten at ~:05 every hour, but the copy the worker sees
//   at hh:37 lags ~2 h: prod first stored each hour ~2.6 h late, and reading
//   only the newest key never stored 22:00 or 23:00 (26 of 26 days in
//   September 2026). Each run therefore reads every key of today's AND
//   yesterday's file; the upsert makes the overlap idempotent.
//
// The station list below is the universe: a station the day files omit is
// unreadable, and one whose every item is 未収集 (st ≠ 0) in every snapshot
// is provider-marked empty.
//
// JSON structure:
//   { "YYYY-MM-DD-HH-MM": { "8193_7_N": { "7_10": {dt, st}, ... } }, …, "update": "..." }
//
// Item codes (st==0 = valid; st==-1 = 未収集):
//   7_10  貯水位 [EL.m]
//   7_20  貯水量 [千m³]
//   7_41  利水貯水率(洪水期) [%]    — used 6/16〜9/30 (see FLOOD_SEASON)
//   7_42  利水貯水率(非洪水期) [%]  — used the rest of the year
//   7_50  流入量 [m³/s]
//   7_70  全放流量 [m³/s]
//
// Priority 313 (lower than cgr-mlit-dam 304, so CGR wins for 尾原/志津見).
// Cron: hourly at :37.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.SHIMANE_BOUSAI_URL ?? 'https://www.suibou-shimane.jp';

const PREF_CODE = '32';
const SOURCE_ID = 'shimane-bousai';

// Station map from /pc/dam/2110.html (TRANS-02-0708193NNNN-01 → 8193_7_N).
const STATIONS: ReadonlyArray<{ stationId: string; name: string }> = [
  { stationId: '8193_7_1', name: '布部ダム' },
  { stationId: '8193_7_2', name: '山佐ダム' },
  { stationId: '8193_7_3', name: '三瓶ダム' },
  { stationId: '8193_7_4', name: '八戸ダム' },
  { stationId: '8193_7_5', name: '浜田ダム' },
  { stationId: '8193_7_7', name: '御部ダム' },
  { stationId: '8193_7_9', name: '銚子ダム' },
  { stationId: '8193_7_10', name: '美田ダム' },
  { stationId: '8193_7_11', name: '大長見ダム' },
  { stationId: '8193_7_13', name: '笹倉ダム' },
  { stationId: '8193_7_14', name: '大峠ダム' },
  { stationId: '8193_7_16', name: '益田川ダム' },
  { stationId: '8193_7_17', name: '第二浜田ダム' },
  { stationId: '8193_7_18', name: '波積ダム' },
  { stationId: '8193_7_600', name: '嵯峨谷ダム' },
  { stationId: '8193_7_601', name: '津田川ダム' },
  { stationId: '8193_7_602', name: '清瀧ダム' },
  { stationId: '8193_7_603', name: '三成ダム' },
  { stationId: '8193_7_604', name: '木都賀ダム' },
];

// --- types ------------------------------------------------------------------

interface StationData {
  [itemCode: string]: { dt: string; st: number };
}

interface Snapshot {
  ts: string;
  observedAt: Date;
  stations: Record<string, StationData>;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD-HH-MM" JST → UTC Date. */
export function parseShimaneTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

// 洪水期 6/16〜9/30 (JST), per 布部・八戸 — the only two stations whose 7_41 and
// 7_42 differ; every other station publishes the same value in both. The page
// itself states no dates; they come from the issue #56 survey, and the feed
// agrees: on 6/6 both still held more than their 洪水期 pool (7_41 = 100.0).
const FLOOD_SEASON = { from: '06-16', to: '09-30' } as const;

/** Is the feed key "YYYY-MM-DD-HH-MM" (JST) inside 洪水期? */
export function isFloodSeason(ts: string): boolean {
  const monthDay = ts.slice(5, 10);
  return monthDay >= FLOOD_SEASON.from && monthDay <= FLOOD_SEASON.to;
}

/** One item: a value when st == 0, the provider's mark otherwise. */
function item(station: StationData, code: string): Cell {
  const it = station[code];
  if (!it) return null;
  return cell(Number(it.dt), it.st !== 0);
}

/** Every hourly snapshot in a day file, oldest first. */
function snapshotsOf(data: Record<string, unknown>): Snapshot[] {
  const out: Snapshot[] = [];
  for (const ts of Object.keys(data)
    .filter((k) => k !== 'update')
    .sort()) {
    const observedAt = parseShimaneTimestamp(ts);
    if (!observedAt) continue;
    out.push({ ts, observedAt, stations: data[ts] as Record<string, StationData> });
  }
  return out;
}

function stationReading(stationId: string, snapshots: Snapshot[], absentWhy: string): Reading {
  const observations: Observed[] = [];
  let listed = 0;
  let allMarked = true;
  for (const { ts, observedAt, stations } of snapshots) {
    const st = stations[stationId];
    if (!st) continue;
    listed += 1;
    const level = item(st, '7_10');
    const storageThou = item(st, '7_20');
    // No cross-season fallback: for 布部/八戸 the other column is a different
    // denominator, and a wrong-basis rate is worse than none.
    const rate = item(st, isFloodSeason(ts) ? '7_41' : '7_42');
    const inflow = item(st, '7_50');
    const outflow = item(st, '7_70');
    const state = cellState([level, storageThou, rate, inflow, outflow]);
    if (state !== 'empty') allMarked = false;
    if (state !== 'values') continue;
    const thou = numberIn(storageThou);
    const ratePct = numberIn(rate);
    observations.push({
      observedAt,
      waterLevelM: numberIn(level),
      storageVolumeM3: thou !== null ? thou * 1_000 : null,
      storageRate: ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      inflowM3s: numberIn(inflow),
      outflowM3s: numberIn(outflow),
    });
  }
  if (observations.length > 0) return { state: 'values', observations };
  if (listed === 0) return { state: 'unreadable', why: absentWhy };
  if (allMarked) return { state: 'empty', mark: '未収集 (st ≠ 0) on every item, every hour' };
  return { state: 'unreadable', why: 'no st-0 value' };
}

/**
 * One entry per station, reading every hourly key of the day files given
 * (oldest first). `absentWhy` is why a station missing from them is
 * unreadable.
 */
export function shimaneEntries(
  dayFiles: readonly Record<string, unknown>[],
  absentWhy = 'not in the day files',
): Entry[] {
  const snapshots = dayFiles.flatMap(snapshotsOf);
  return STATIONS.map(({ stationId, name }) => ({
    key: stationId,
    name,
    pref: PREF_CODE,
    reading: stationReading(stationId, snapshots, absentWhy),
  }));
}

/** YYYYMMDD of yesterday and today in JST — the day files one run reads. */
export function dayFileDates(now: Date): string[] {
  const jst = (offsetDays: number): string =>
    new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
      .replace(/-/g, '');
  return [jst(-1), jst(0)];
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const files: Record<string, unknown>[] = [];
  const failures: string[] = [];
  for (const day of dayFileDates(new Date())) {
    const url = `${BASE_URL}/dyn/dps/json/${day}/dam60.json`;
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(20_000),
      });
      // Today's file does not exist until the first snapshot after 00:00 JST.
      if (res.status !== 200) {
        failures.push(`HTTP ${res.status} for ${day}`);
        log(`${SOURCE_ID}: HTTP ${res.status} for ${url}; skipping`);
        continue;
      }
      files.push((await res.json()) as Record<string, unknown>);
    } catch (err) {
      failures.push(`${day}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // The station list is known in advance: when no day file could be read,
  // every station is still listed, as unreadable.
  const absentWhy = files.length === 0 ? failures.join('; ') : 'not in the day files';
  return { entries: shimaneEntries(files, absentWhy) };
});
