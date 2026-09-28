// apps/worker/src/tasks/ingest_kagoshima_bousai.ts
//
// 鹿児島県防災ポータル ダム情報 — 県管理ダム hourly.
//
// Source:
//   https://www.bousai-kagoshima.jp/bousai_data/tm/dam_station.json
//   (JSON API, globally accessible — not geo-blocked)
//
// NOTE: This endpoint is populated only during active flood/disaster events.
//   During normal conditions the "items" array is empty. The adapter handles
//   this gracefully and exits early when no dam data is present.
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
// recorded in the universe but writes no observation.
//
// Priority 308 (hourly pref-managed). Cron :56 (spaced from other sources).

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

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

export interface ParsedRow {
  stationName: string;
  /** The portal's own station id — the stable key for `source_universe`. */
  stationNo: string;
  lat: number | null;
  lng: number | null;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
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

function toNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isFinite(v) ? v : null;
}

export function parseItems(items: BousaiItem[]): ParsedRow[] {
  return items.map((item) => {
    // WKT "POINT(lon lat)"; the vendor prints POINT(0 0) for an unlocated station.
    const wkt = item.point?.match(/^POINT\((-?[\d.]+) (-?[\d.]+)\)$/);
    const lng = wkt ? Number(wkt[1]) : 0;
    const lat = wkt ? Number(wkt[2]) : 0;
    const located = Number.isFinite(lng) && Number.isFinite(lat) && (lng !== 0 || lat !== 0);
    return {
      stationName: item.station_name,
      stationNo: item.station_no,
      lat: located ? lat : null,
      lng: located ? lng : null,
      observedAt: parseKagoshimaTimestamp(item.obs_datetime),
      waterLevelM: toNum(item.store),
      // stored is in 千m³; convert to m³
      storageVolumeM3: toNum(item.stored) !== null ? (toNum(item.stored) as number) * 1_000 : null,
      inflowM3s: toNum(item.inflow),
      outflowM3s: toNum(item.discharge),
    };
  });
}

/** Observation inputs for the matched stations with a timestamp and any value. */
export function toObservations(
  rows: ParsedRow[],
  damByName: Map<string, bigint>,
  log: (s: string) => void,
): Parameters<typeof upsertObservations>[0] {
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.stationName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.stationName}"; skipping`);
      continue;
    }
    if (
      p.waterLevelM === null &&
      p.storageVolumeM3 === null &&
      p.inflowM3s === null &&
      p.outflowM3s === null
    ) {
      log(`${SOURCE_ID}: "${p.stationName}" has no values; skipping`);
      continue;
    }
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  return inputs;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '鹿児島県防災ポータル ダム情報 — JSON API, hourly (active during flood events)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

interface DamMatch {
  stationName: string;
  damId: bigint;
}

/**
 * Best master dam for a station: the row already stamped with its
 * `station_no` keeps it; otherwise an exact raw-name hit beats a stem hit
 * beats a prefix/substring hit, and equal ranks go to the live （元）/（再）
 * twin before the lower id.
 */
export function chooseMaster(
  rawName: string,
  stem: string,
  masters: BindableMaster[],
  stationKey: string,
): bigint | null {
  const stamped = stampedMaster(masters, stationKey);
  if (stamped) return stamped.id;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === rawName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.stationName);
    if (!stem) continue;

    const damId = chooseMaster(r.stationName, stem, masters, r.stationNo);

    universe.push({
      externalId: r.stationNo,
      name: r.stationName,
      prefCode: PREF_CODE,
      lat: r.lat,
      lng: r.lng,
      resolvedDamId: damId,
    });

    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.stationName}"`);
      continue;
    }
    out.push({ stationName: r.stationName, damId });
    await bindExternalId(damId, SOURCE_ID, r.stationNo);
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  const data = (await r.json()) as BousaiResponse;
  const items = data.items ?? [];

  if (items.length === 0) {
    // Deliberately records nothing: an empty portal is not a scan. This
    // source is marked universe_enumerable = FALSE (migration 0044) precisely
    // because it lists dams only during a flood event, so it is excluded from
    // the coverage gate rather than faking an empty scan here.
    log(`${SOURCE_ID}: no items (portal inactive — normal outside flood events)`);
    return;
  }

  const rows = parseItems(items);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const inputs = toObservations(rows, new Map(matches.map((m) => [m.stationName, m.damId])), log);
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
