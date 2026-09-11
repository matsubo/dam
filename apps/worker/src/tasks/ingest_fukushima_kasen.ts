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
//   HTML table at /web_pub/dam/010401_60_1_0.html.
//
// Priority 308. Cron hourly at :34.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.FUKUSHIMA_KASEN_URL ?? 'https://kaseninf.pref.fukushima.jp/dyn/json/dat/pc';

const PREF_CODE = '07';
const SOURCE_ID = 'fukushima-kasen';

// --- station map (type-7 dam IDs → prefectural dam names) ------------------
// Skip: 1799_7_3 (桧原湖), 1799_7_23 / 1799_7_21 / 1799_7_22 (natural lakes / 水門).

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

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  fukushimaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

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

function parseVal(s: string | undefined): number | null {
  if (!s || s === '*' || s === '--' || s === '---' || s === '**') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
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

export function parseFukushimaJson(json: FukushimaJson): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const [stationId, fukushimaName] of Object.entries(STATION_MAP)) {
    const stationData = json[stationId];
    if (!stationData || typeof stationData === 'string') continue;
    const latest = (stationData as StationData).data60?.[0];
    if (!latest?.time) continue;

    const observedAt = parseFukushimaTimestamp(latest.time);
    if (!observedAt) continue;

    const waterLevelM = parseVal(latest.item_10?.val);
    const inflowM3s = parseVal(latest.item_50?.val);
    const outflowM3s = parseVal(latest.item_70?.val);
    const rainfallMm = parseVal(latest.item_1_70?.val);

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({ fukushimaName, observedAt, waterLevelM, inflowM3s, outflowM3s, rainfallMm });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '福島県河川流域総合情報システム — 11 県管理ダム hourly JSON',
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
  fukushimaName: string;
  damId: bigint;
}

/**
 * Best master dam for a name as this source publishes it: an exact raw-name
 * hit beats stem equality, which beats the `〜ダム` spelling, a prefix, then a
 * substring; ties go to the lowest master id. Extracted verbatim from the
 * match loop so the catalogue can be resolved without re-implementing it.
 */
function chooseMaster(
  publishedName: string,
  masters: { id: bigint; name: string }[],
): bigint | null {
  const stem = normalizeName(publishedName);
  if (!stem) return null;

  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === publishedName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Built
  // from STATION_MAP, the provider's whole catalogue, rather than from the
  // rows that parsed this run: a station that has never reported would
  // otherwise stay invisible and, once the scan gate closes, be reported as
  // published by nobody. Keyed by the JSON station id the feed itself uses.
  const universe: UniverseRow[] = Object.entries(STATION_MAP).map(([stationId, name]) => ({
    externalId: stationId,
    name,
    prefCode: PREF_CODE,
    resolvedDamId: chooseMaster(name, masters),
  }));

  for (const r of rows) {
    const stem = normalizeName(r.fukushimaName);
    if (!stem) continue;

    const damId = chooseMaster(r.fukushimaName, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.fukushimaName}"`);
      continue;
    }
    out.push({ fukushimaName: r.fukushimaName, damId });
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const url = buildFukushimaUrl(new Date(), BASE_URL);
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

  const json = (await r.json()) as FukushimaJson;
  const rows = parseFukushimaJson(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.fukushimaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.fukushimaName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: p.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
