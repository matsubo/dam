// apps/worker/src/tasks/ingest_kagoshima_bousai.ts
//
// 鹿児島県防災ポータル ダム情報 — 県管理ダム hourly.
//
// Source:
//   https://www.bousai-kagoshima.jp/bousai_data/tm/dam_station.json
//   (JSON API, globally accessible — not geo-blocked)
//
// NOTE: This endpoint is populated only during active flood/disaster events.
//   During normal conditions the "items" array is empty, and the scan lists
//   nothing: this source is marked universe_enumerable = FALSE (migration
//   0044) precisely because it lists dams only during a flood event, so the
//   run records nothing rather than faking an empty scan.
//
// Response shape (when items are present). The Kagoshima feed has never been
// seen populated; this is the vendor's shape as served live by its Kagawa
// portal (bousai-kagawa.jp/bousai_data/tm/dam_station.json, 2026-09-28):
//   {
//     "result": 0, "message": "", "ret_time": "YYYY/MM/DD HH:MM",
//     "items": [
//       {
//         "station_name": "門入ダム",
//         "station_no":   "013707007000000000",
//         "point":        "POINT(134.21909 34.24903)",  // WKT lon lat; POINT(0 0) = unlocated
//         "obs_datetime": "YYYY/MM/DD HH:MM",
//         "store":        97.09,   // 貯水位 [EL.m]
//         "stored":       1731,    // 貯水量 [千m³]
//         "inflow":       0.05,    // 流入量 [m³/s]
//         "discharge":    0.02     // 放流量 [m³/s]
//       }
//     ]
//   }
// A station may be listed with every value null (Kagawa's 粟井ダム); it is
// provider-marked empty.
//
// Priority 308 (hourly pref-managed). Cron :56 (spaced from other sources).

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.KAGOSHIMA_BOUSAI_URL ??
  'https://www.bousai-kagoshima.jp/bousai_data/tm/dam_station.json';

const PREF_CODE = '46';
const SOURCE_ID = 'kagoshima-bousai';

// --- types ------------------------------------------------------------------

export interface BousaiItem {
  station_name: string;
  station_no: string;
  point?: string;
  obs_datetime: string;
  store?: number | null;
  stored?: number | null;
  inflow?: number | null;
  discharge?: number | null;
}

export interface BousaiResponse {
  result: number;
  message: string;
  ret_time: string;
  items: BousaiItem[];
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseKagoshimaTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An explicit null is the portal's own blank; a missing field is unreadable. */
function field(v: number | null | undefined): Cell {
  if (v === undefined) return null;
  return cell(v, v === null);
}

function itemReading(item: BousaiItem): Reading {
  const level = field(item.store);
  const storedThou = field(item.stored);
  const inflow = field(item.inflow);
  const outflow = field(item.discharge);
  const state = cellState([level, storedThou, inflow, outflow]);
  if (state === 'empty') return { state, mark: 'every value null' };
  if (state === 'unreadable') return { state, why: 'no numeric value' };
  const observedAt = parseKagoshimaTimestamp(item.obs_datetime ?? '');
  if (!observedAt) return { state: 'unreadable', why: `obs_datetime "${item.obs_datetime}"` };
  const thou = numberIn(storedThou);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        // stored is in 千m³; convert to m³
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * One entry per listed station, keyed by the portal's own station_no; an item
 * without a number or a name cannot be an entry.
 */
export function kagoshimaBousaiEntries(items: BousaiItem[]): Entry[] {
  const named = items.filter((i) => i.station_no?.trim() && i.station_name?.trim());
  return named.map((item) => {
    // WKT "POINT(lon lat)"; the vendor prints POINT(0 0) for an unlocated station.
    const wkt = item.point?.match(/^POINT\((-?[\d.]+) (-?[\d.]+)\)$/);
    const lng = wkt ? Number(wkt[1]) : 0;
    const lat = wkt ? Number(wkt[2]) : 0;
    const located = Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0);
    // The master files a 貯水池 under its bare name.
    const bare = item.station_name.replace(/貯水池$/, '');
    return {
      key: item.station_no,
      name: item.station_name,
      pref: PREF_CODE,
      ...(bare !== item.station_name ? { bind: { name: bare } } : {}),
      lat: located ? lat : null,
      lng: located ? lng : null,
      reading: itemReading(item),
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

  const data = (await r.json()) as BousaiResponse;
  const entries = kagoshimaBousaiEntries(data.items ?? []);
  log(`${SOURCE_ID}: ${entries.length} stations at ${data.ret_time}`);
  return { entries };
});
