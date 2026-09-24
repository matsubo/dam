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
//   Updated ~every 60 min. Single JSON with one timestamp key + "update".
//
// JSON structure:
//   { "YYYY-MM-DD-HH-MM": { "8193_7_N": { "7_10": {dt, st}, ... } }, "update": "..." }
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

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

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

export interface ParsedRow {
  stationId: string;
  shimaneName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
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

/** Extract numeric value if station item is valid (st == 0). */
function getItem(station: StationData, code: string): number | null {
  const item = station[code];
  if (item?.st !== 0) return null;
  const n = Number(item.dt);
  return Number.isFinite(n) ? n : null;
}

export function parseShimaneSnapshot(data: Record<string, unknown>): ParsedRow[] {
  const tsKeys = Object.keys(data).filter((k) => k !== 'update');
  if (!tsKeys.length) return [];

  // Take the most recent timestamp key.
  const ts = tsKeys.sort().at(-1) ?? '';
  const observedAt = parseShimaneTimestamp(ts);
  if (!observedAt) return [];

  const snapshot = data[ts] as Record<string, StationData>;
  const rateItem = isFloodSeason(ts) ? '7_41' : '7_42';
  const rows: ParsedRow[] = [];

  for (const { stationId, name } of STATIONS) {
    const st = snapshot[stationId];
    if (!st) continue;

    const waterLevelM = getItem(st, '7_10');
    const storageThouM3 = getItem(st, '7_20');
    const storageVolM3 = storageThouM3 !== null ? storageThouM3 * 1_000 : null;
    // No cross-season fallback: for 布部/八戸 the other column is a different
    // denominator, and a wrong-basis rate is worse than none.
    const ratePct = getItem(st, rateItem);
    const storageRate = ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null;
    const inflowM3s = getItem(st, '7_50');
    const outflowM3s = getItem(st, '7_70');

    if (
      waterLevelM === null &&
      storageVolM3 === null &&
      storageRate === null &&
      inflowM3s === null &&
      outflowM3s === null
    )
      continue;

    rows.push({
      stationId,
      shimaneName: name,
      observedAt,
      waterLevelM,
      storageVolumeM3: storageVolM3,
      storageRate,
      inflowM3s,
      outflowM3s,
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 313,
            '島根県水防情報システム (suibou-shimane.jp) — 19ダム hourly JSON',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

interface DamMatch {
  stationId: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Seeded
  // from the station list rather than from this run's rows, so a station the
  // snapshot omits today still counts as published; the resolved rows pushed
  // below supersede these (recordUniverse keeps the last entry per id).
  const universe: UniverseRow[] = STATIONS.map(({ stationId, name }) => ({
    externalId: stationId,
    name,
    prefCode: PREF_CODE,
    resolvedDamId: null,
  }));

  for (const r of rows) {
    const stem = normalizeName(r.shimaneName);

    let best: { id: bigint; rank: number } | null = null;
    if (stem) {
      for (const m of masters) {
        const mStem = normalizeName(m.name);
        let rank: number;
        if (m.name === r.shimaneName) rank = 0;
        else if (mStem === stem) rank = 1;
        else if (m.name === `${stem}ダム`) rank = 2;
        else if (mStem.startsWith(stem)) rank = 3;
        else if (mStem.includes(stem)) rank = 4;
        else continue;
        if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
          best = { id: m.id, rank };
        }
      }
    }

    universe.push({
      externalId: r.stationId,
      name: r.shimaneName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.shimaneName}" (${r.stationId})`);
      continue;
    }

    out.push({ stationId: r.stationId, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.stationId}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.stationId}
    `;
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Use JST date to build the URL (data files are keyed by JST calendar date).
  const jstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const day = jstDate.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `${BASE_URL}/dyn/dps/json/${day}/dam60.json`;

  const res = await fetch(url, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status} for ${url}; aborting`);
    return;
  }

  const data = (await res.json()) as Record<string, unknown>;
  const rows = parseShimaneSnapshot(data);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByStation = new Map(matches.map((m) => [m.stationId, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByStation.get(p.stationId);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
