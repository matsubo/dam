// apps/worker/src/tasks/ingest_fukushima_kasen.ts
//
// 福島県河川流域総合情報システム ダム諸量 — 11 県管理ダム hourly.
//
//   こまちダム / 千五沢ダム / 堀川ダム / 真野ダム / 木戸ダム / 小玉ダム /
//   高柴ダム / 四時ダム / 日中ダム / 東山ダム / 田島ダム
//
// Source:
//   https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc/{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json
//   Date is JST calendar date; file regenerated each hour.
//
// Format: JSON. Station IDs are keys like "1797_7_1". data60 has 24 hourly
//   readings, most-recent first.
//   item_10   = 貯水位[m]
//   item_50   = 全流入量[m³/s]
//   item_70   = 全放流量[m³/s]
//   item_1_70 = 時間雨量[mm]
//   time      = "YYYY-MM-DD-HH-mm" (JST)
//
// Station-to-name mapping derived by matching water-level values against the
//   HTML table at /web_pub/dam/010401_60_1_0.html (re-checked 2026-10-27).
// "*", "**", "--", "---" are the feed's own blanks.
//
// Priority 308. Cron hourly at :34.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL =
  process.env.FUKUSHIMA_KASEN_URL ?? 'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc';

const PREF_CODE = '07';
const SOURCE_ID = 'fukushima-kasen';

// --- station map (type-7 dam IDs → prefectural dam names) ------------------

const STATION_MAP: Readonly<Record<string, string>> = {
  '1797_7_1': 'こまちダム',
  '1797_7_2': '千五沢ダム',
  '1798_7_1': '堀川ダム',
  '1794_7_2': '真野ダム',
  '1794_7_5': '木戸ダム',
  '1795_7_3': '小玉ダム',
  '1795_7_1': '高柴ダム',
  '1795_7_2': '四時ダム',
  '1799_7_1': '日中ダム',
  '1800_7_1': '東山ダム',
  '1801_7_1': '田島ダム',
};

// The same table also lists three natural lakes and a 水門 (猪苗代湖's outlet
// gate), matched by water level the same way: recorded, never bound to a dam.
const NOT_DAMS: Readonly<Record<string, string>> = {
  '1799_7_21': '桧原湖',
  '1799_7_22': '小野川湖',
  '1799_7_23': '秋元湖',
  '1799_7_3': '十六橋水門',
};

// --- types ------------------------------------------------------------------

interface ItemVal {
  val?: string;
  lvl?: number;
}

interface DataPoint {
  time?: string;
  item_10?: ItemVal;
  item_50?: ItemVal;
  item_70?: ItemVal;
  item_1_70?: ItemVal;
}

interface StationData {
  data60?: DataPoint[];
}

interface FukushimaJson {
  observationTime?: string;
  updateTime?: string;
  [stationId: string]: StationData | string | undefined;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD-HH-mm" (JST) → UTC. Returns null for invalid input. */
export function parseFukushimaTimestamp(ts: string): Date | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value: "*", "**", "--", "---" are the feed's own marks. */
function valueCell(s: string | undefined): Cell {
  if (s === '*' || s === '**' || s === '--' || s === '---') return MARKED;
  return cell(s ? Number(s.replace(/,/g, '')) : null, false);
}

/** Build the data JSON URL for the given UTC wall-clock moment. */
export function buildFukushimaUrl(nowUtc: Date, baseUrl: string): string {
  const jst = new Date(nowUtc.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(jst.getUTCDate()).padStart(2, '0');
  const ds = `${y}${mo}${dy}`;
  return `${baseUrl}/${ds}/${ds}_1_dam_60.json`;
}

/** A station's reading: its latest (first) hourly point. */
function stationReading(json: FukushimaJson, stationId: string): Reading {
  const stationData = json[stationId];
  if (!stationData || typeof stationData === 'string') {
    return { state: 'unreadable', why: 'station absent from the feed' };
  }
  const latest = stationData.data60?.[0];
  if (!latest) return { state: 'unreadable', why: 'no data60 point' };

  const level = valueCell(latest.item_10?.val);
  const inflow = valueCell(latest.item_50?.val);
  const outflow = valueCell(latest.item_70?.val);
  const rain = valueCell(latest.item_1_70?.val);
  const state = cellState([level, inflow, outflow, rain]);
  if (state === 'empty') return { state, mark: '"*" / "--" on every item' };
  if (state === 'unreadable') return { state, why: 'no numeric item' };
  const observedAt = parseFukushimaTimestamp(latest.time ?? '');
  if (!observedAt) return { state: 'unreadable', why: `time "${latest.time}"` };
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        rainfallMm: numberIn(rain),
      },
    ],
  };
}

/**
 * The provider's whole catalogue, keyed by the JSON station id the feed
 * itself uses, so a station that has never reported is still recorded.
 * `json` is null when this run's file could not be fetched.
 */
export function fukushimaEntries(json: FukushimaJson | null, why = 'feed not fetched'): Entry[] {
  const failed: Reading = { state: 'unreadable', why };
  return [
    ...Object.entries(STATION_MAP).map(([id, name]) => ({
      key: id,
      name,
      pref: PREF_CODE,
      reading: json ? stationReading(json, id) : failed,
    })),
    ...Object.entries(NOT_DAMS).map(([id, name]) => ({
      key: id,
      name,
      pref: PREF_CODE,
      bind: 'never' as const,
      reading: json ? stationReading(json, id) : failed,
    })),
  ];
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const url = buildFukushimaUrl(new Date(), BASE_URL);
  try {
    const r = await upstream.fetch(url);
    return { entries: fukushimaEntries(r.json<FukushimaJson>()) };
  } catch (err) {
    // The catalogue is known in advance: a failed fetch still records it.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: fukushimaEntries(null, why) };
  }
});
