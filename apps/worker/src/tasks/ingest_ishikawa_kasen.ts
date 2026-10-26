// apps/worker/src/tasks/ingest_ishikawa_kasen.ts
//
// 石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly.
//
//   八ヶ川 / 新内川 / 内川 / 赤瀬 / 我谷 / 九谷 / 小屋 / 北河内 /
//   辰巳 / 犀川 / 大日川
//   ※ 手取川ダム(国) は MLIT cgr-mlit-dam (優先度 304) で取得済みのため記録のみ.
//
// Source:
//   https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline/{YYYYMMDD}/{YYYYMMDD}_1_dam_60.json
//   Date is JST calendar date; the file is regenerated each hour.
//
// Format: JSON. Station IDs are keys like "4361_7_41". Data60 array has the
//   last 18 hourly readings, most-recent first.
//   item_10 = 貯水位[m]
//   item_20 = 貯水量[千m³]  (comma-separated integer, multiply ×1000 → m³)
//   item_50 = 全流入量[m³/s]
//   item_70 = 全放流量[m³/s]
//   time    = "YYYY-MM-DD-HH-mm" (JST)
//
// Station-to-name mapping derived from p2000.html Knockout template bindings
//   (KnockoutJS<!-- ko with: … '4361_7_41' … -->八ヶ川ダム).
// "*", "--", "---" are the feed's own blanks.
//
// Priority 308. Cron hourly at :28.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL =
  process.env.ISHIKAWA_KASEN_URL ?? 'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline';

const PREF_CODE = '17';
const SOURCE_ID = 'ishikawa-kasen';

// --- station map (type-7 dam IDs → prefectural dam names) ------------------

const STATION_MAP: Readonly<Record<string, string>> = {
  '4361_7_41': '八ヶ川ダム',
  '4369_7_63': '新内川ダム',
  '4369_7_62': '内川ダム',
  '4369_7_64': '赤瀬ダム',
  '4354_7_1': '我谷ダム',
  '4354_7_2': '九谷ダム',
  '4362_7_51': '小屋ダム',
  '4361_7_31': '北河内ダム',
  '4369_7_65': '辰巳ダム',
  '4369_7_61': '犀川ダム',
  '4356_7_21': '大日川ダム',
};

// 手取川ダム(国) is recorded but not written: MLIT-managed, covered by cgr-mlit.
const TEDORIGAWA = { id: '21565_7_1', name: '手取川ダム' } as const;

// --- types ------------------------------------------------------------------

interface ItemVal {
  val?: string;
  lvl?: number;
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

interface IshikawaJson {
  observationTime?: string;
  updateTime?: string;
  [stationId: string]: StationData | string | undefined;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD-HH-mm" (JST) → UTC. Returns null for invalid input. */
export function parseIshikawaTimestamp(ts: string): Date | null {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A value string that may contain commas (e.g. "133,532"); "*", "--", "---"
 * are the feed's own marks.
 */
function valueCell(s: string | undefined): Cell {
  if (s === '*' || s === '--' || s === '---') return MARKED;
  return cell(s ? Number(s.replace(/,/g, '')) : null, false);
}

/** Build the timeline JSON URL for the given UTC wall-clock moment. */
export function buildUrl(nowUtc: Date, baseUrl: string): string {
  // Convert to JST to get the local calendar date
  const jst = new Date(nowUtc.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(jst.getUTCDate()).padStart(2, '0');
  const ds = `${y}${mo}${dy}`;
  return `${baseUrl}/${ds}/${ds}_1_dam_60.json`;
}

/** A station's reading: its latest (first) hourly point. */
function stationReading(json: IshikawaJson, stationId: string): Reading {
  const stationData = json[stationId];
  if (!stationData || typeof stationData === 'string') {
    return { state: 'unreadable', why: 'station absent from the feed' };
  }
  const latest = stationData.data60?.[0];
  if (!latest) return { state: 'unreadable', why: 'no data60 point' };

  const level = valueCell(latest.item_10?.val);
  const storageThou = valueCell(latest.item_20?.val);
  const inflow = valueCell(latest.item_50?.val);
  const outflow = valueCell(latest.item_70?.val);
  const state = cellState([level, storageThou, inflow, outflow]);
  if (state === 'empty') return { state, mark: '"*" on every item' };
  if (state === 'unreadable') return { state, why: 'no numeric item' };
  const observedAt = parseIshikawaTimestamp(latest.time ?? '');
  if (!observedAt) return { state: 'unreadable', why: `time "${latest.time}"` };
  const thou = numberIn(storageThou);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * The provider's whole catalogue, keyed by the JSON station id the feed
 * itself uses, so a station that has never reported is still recorded.
 * `json` is null when this run's file could not be fetched.
 */
export function ishikawaEntries(json: IshikawaJson | null, why = 'feed not fetched'): Entry[] {
  const failed: Reading = { state: 'unreadable', why };
  return [
    ...Object.entries(STATION_MAP).map(([id, name]) => ({
      key: id,
      name,
      pref: PREF_CODE,
      reading: json ? stationReading(json, id) : failed,
    })),
    {
      key: TEDORIGAWA.id,
      name: TEDORIGAWA.name,
      pref: PREF_CODE,
      dontWrite: 'MLIT-managed; cgr-mlit-dam covers it',
      reading: json ? stationReading(json, TEDORIGAWA.id) : failed,
    },
  ];
}

export default ingestTask(SOURCE_ID, async (log) => {
  const url = buildUrl(new Date(), BASE_URL);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
    return { entries: ishikawaEntries((await r.json()) as IshikawaJson) };
  } catch (err) {
    // The catalogue is known in advance: a failed fetch still records it.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: ishikawaEntries(null, why) };
  }
});
