// apps/worker/src/tasks/ingest_nagano_kasen.ts
//
// 長野県 河川砂防情報ステーション ダム諸量 — 17 県管理ダム hourly.
//
//   松川 / 片桐 / 箕輪 / 横川 / 奈良井 / 裾花 / 奥裾花 / 古谷 /
//   内村 / 豊丘 / 余地 / 北山 / 浅川 / 水上 / 小仁熊 / 湯川 / 金原
//
// Source:
//   https://www.sabo-nagano.jp/dyn/json/dat/pc/{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json
//   Date is JST calendar date; file regenerated each hour.
//
// Format: JSON. Station IDs like "2001_7_1". data60 has hourly readings,
//   most-recent first. Field names differ from Fukushima/Ishikawa variants:
//   uses "value"/"level" (not "val"/"lvl").
//   item_10   = 貯水位[m]
//   item_20   = 貯水量[×1000 m³]  → storageVolumeM3 × 1000
//   item_50   = 全流入量[m³/s]
//   item_70   = 全放流量[m³/s]
//   time      = "YYYY-MM-DD-HH-mm" (JST)
//
// Station 2001_7_3 (釜口水門) is a sluice gate: listed, never bound.
// Station names verified against /dps/map/map.html data-river-key attributes.
//
// The published list is the whole STATION_MAP, not this run's rows: the feed
// keeps a station's slot on an hour when it reports no usable value, and a
// station that never reports is exactly the case /coverage must not read as
// "nobody publishes it". When the hour's file cannot be read, every station
// is listed unreadable.
//
// Priority 308. Cron hourly at :33.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.NAGANO_KASEN_URL ?? 'https://www.sabo-nagano.jp/dyn/json/dat/pc';

const PREF_CODE = '20';
const SOURCE_ID = 'nagano-kasen';

// --- station map ------------------------------------------------------------

const STATION_MAP: Readonly<Record<string, string>> = {
  '2001_7_1': '松川ダム',
  '2001_7_2': '片桐ダム',
  '2001_7_3': '釜口水門',
  '2001_7_4': '箕輪ダム',
  '2001_7_5': '横川ダム',
  '2001_7_6': '奈良井ダム',
  '2001_7_7': '裾花ダム',
  '2001_7_8': '奥裾花ダム',
  '2001_7_9': '古谷ダム',
  '2001_7_10': '内村ダム',
  '2001_7_11': '豊丘ダム',
  '2001_7_12': '余地ダム',
  '2001_7_13': '北山ダム',
  '2001_7_14': '浅川ダム',
  '2001_7_15': '水上ダム',
  '2001_7_16': '小仁熊ダム',
  '2001_7_17': '湯川ダム',
  '2001_7_18': '金原ダム',
};

/** 釜口水門: the sluice gate at 諏訪湖's outlet, not a dam. */
const SLUICE_GATE = '2001_7_3';

// --- types ------------------------------------------------------------------

interface ItemVal {
  value?: string;
  level?: number;
}

interface DataPoint {
  time?: string;
  item_10?: ItemVal;
  item_20?: ItemVal;
  item_50?: ItemVal;
  item_70?: ItemVal;
}

interface StationData {
  data60?: DataPoint[];
}

export interface NaganoJson {
  observationTime?: string;
  updateTime?: string;
  [stationId: string]: StationData | string | undefined;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD-HH-mm" (JST) → UTC. Returns null for invalid input. */
export function parseNaganoTimestamp(ts: string): Date | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A value cell; the feed marks a missing value with *, --, --- or **. */
function parseVal(s: string | undefined): Cell {
  if (s === '*' || s === '--' || s === '---' || s === '**') return cell(null, true);
  if (!s) return null;
  return cell(Number(s.replace(/,/g, '')), false);
}

/** Build the data JSON URL for the given UTC wall-clock moment. */
export function buildNaganoUrl(nowUtc: Date, baseUrl: string): string {
  const jst = new Date(nowUtc.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(jst.getUTCDate()).padStart(2, '0');
  const ds = `${y}${mo}${dy}`;
  return `${baseUrl}/${ds}/${ds}_1_dam_60.json`;
}

/** One station's latest hourly reading. */
export function naganoReading(json: NaganoJson, stationId: string): Reading {
  const stationData = json[stationId];
  if (!stationData || typeof stationData === 'string') {
    return { state: 'unreadable', why: 'station absent from the hour file' };
  }
  const latest = stationData.data60?.[0];
  const observedAt = latest?.time ? parseNaganoTimestamp(latest.time) : null;
  if (!latest || !observedAt) {
    return { state: 'unreadable', why: `data60[0].time "${latest?.time ?? ''}"` };
  }

  const level = parseVal(latest.item_10?.value);
  const volume = parseVal(latest.item_20?.value);
  const inflow = parseVal(latest.item_50?.value);
  const outflow = parseVal(latest.item_70?.value);
  const state = cellState([level, volume, inflow, outflow]);
  if (state === 'empty') return { state, mark: '* / -- on every field' };
  if (numberIn(level) === null && numberIn(inflow) === null && numberIn(outflow) === null) {
    return { state: 'unreadable', why: 'no 貯水位 or flow' };
  }
  const volRaw = numberIn(volume);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/** Every station of STATION_MAP, read from the hour file (null: unreadable). */
export function naganoEntries(json: NaganoJson | null, why = 'hour file unreadable'): Entry[] {
  return Object.entries(STATION_MAP).map(
    ([stationId, naganoName]): Entry => ({
      key: stationId,
      name: naganoName,
      pref: PREF_CODE,
      ...(stationId === SLUICE_GATE ? { bind: 'never' as const } : {}),
      reading: json ? naganoReading(json, stationId) : { state: 'unreadable', why },
    }),
  );
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const url = buildNaganoUrl(new Date(), BASE_URL);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return { entries: naganoEntries((await r.json()) as NaganoJson) };
  } catch (err) {
    const why = `${url}: ${err instanceof Error ? err.message : String(err)}`;
    log(`${SOURCE_ID}: ${why}`);
    return { entries: naganoEntries(null, why) };
  }
});
