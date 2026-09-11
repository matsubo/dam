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
// Station 2001_7_3 (釜口水門) is a sluice gate — excluded from STATION_MAP.
// Station names verified against /dps/map/map.html data-river-key attributes.
//
// Priority 308. Cron hourly at :33.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.NAGANO_KASEN_URL ?? 'https://www.sabo-nagano.jp/dyn/json/dat/pc';

const PREF_CODE = '20';
const SOURCE_ID = 'nagano-kasen';

// --- station map ------------------------------------------------------------
// Skip 2001_7_3 (釜口水門 — sluice gate, not a dam).

const STATION_MAP: Readonly<Record<string, string>> = {
  '2001_7_1': '松川ダム',
  '2001_7_2': '片桐ダム',
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

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  naganoName: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

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

interface NaganoJson {
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

function parseVal(s: string | undefined): number | null {
  if (!s || s === '*' || s === '--' || s === '---' || s === '**') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
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

export function parseNaganoJson(json: NaganoJson): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const [stationId, naganoName] of Object.entries(STATION_MAP)) {
    const stationData = json[stationId];
    if (!stationData || typeof stationData === 'string') continue;
    const latest = (stationData as StationData).data60?.[0];
    if (!latest?.time) continue;

    const observedAt = parseNaganoTimestamp(latest.time);
    if (!observedAt) continue;

    const waterLevelM = parseVal(latest.item_10?.value);
    const volRaw = parseVal(latest.item_20?.value);
    const inflowM3s = parseVal(latest.item_50?.value);
    const outflowM3s = parseVal(latest.item_70?.value);

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({
      naganoName,
      observedAt,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      waterLevelM,
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
    VALUES (${SOURCE_ID}, 308,
            '長野県 河川砂防情報ステーション — 17 県管理ダム hourly JSON',
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
  naganoName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The
  // published list is the whole STATION_MAP, not this run's rows: the feed
  // keeps a station's slot on an hour when it reports no usable value, and a
  // station that never reports is exactly the case /coverage must not read as
  // "nobody publishes it". Only stations that did report become matches.
  const universe: UniverseRow[] = [];
  const reported = new Set(rows.map((r) => r.naganoName));

  for (const [stationId, naganoName] of Object.entries(STATION_MAP)) {
    const stem = normalizeName(naganoName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === naganoName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    universe.push({
      externalId: stationId,
      name: naganoName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${naganoName}"`);
      continue;
    }
    if (reported.has(naganoName)) out.push({ naganoName, damId: best.id });
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const url = buildNaganoUrl(new Date(), BASE_URL);
  const r = await fetch(url, {
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

  const json = (await r.json()) as NaganoJson;
  const rows = parseNaganoJson(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.naganoName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.naganoName);
    if (!damId) continue;
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

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
