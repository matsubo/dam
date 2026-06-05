// apps/worker/src/tasks/ingest_ishikawa_kasen.ts
//
// 石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly.
//
//   八ヶ川 / 新内川 / 内川 / 赤瀬 / 我谷 / 九谷 / 小屋 / 北河内 /
//   辰巳 / 犀川 / 大日川
//   ※ 手取川ダム(国) は MLIT cgr-mlit-dam (優先度 304) で取得済みのため除外.
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
//
// Priority 308. Cron hourly at :28.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.ISHIKAWA_KASEN_URL ?? 'https://kasen.pref.ishikawa.lg.jp/dyn/dps/timeline';

const PREF_CODE = '17';
const SOURCE_ID = 'ishikawa-kasen';

// --- station map (type-7 dam IDs → prefectural dam names) ------------------
// 手取川ダム(国) = 21565_7_1 is excluded (MLIT-managed, covered by cgr-mlit).

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

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  ishikawaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

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
 * Parse a value string that may contain commas (e.g. "133,532") or "*".
 * Returns null for missing / "*" / non-numeric.
 */
function parseVal(s: string | undefined): number | null {
  if (!s || s === '*' || s === '--' || s === '---') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
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

export function parseIshikawaJson(json: IshikawaJson): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const [stationId, ishikawaName] of Object.entries(STATION_MAP)) {
    const stationData = json[stationId];
    if (!stationData || typeof stationData === 'string') continue;
    const latest = (stationData as StationData).data60?.[0];
    if (!latest?.time) continue;

    const observedAt = parseIshikawaTimestamp(latest.time);
    if (!observedAt) continue;

    const waterLevelM = parseVal(latest.item_10?.val);
    const storageThousandM3 = parseVal(latest.item_20?.val);
    const storageVolumeM3 = storageThousandM3 !== null ? storageThousandM3 * 1000 : null;
    const inflowM3s = parseVal(latest.item_50?.val);
    const outflowM3s = parseVal(latest.item_70?.val);

    if (
      waterLevelM === null &&
      storageVolumeM3 === null &&
      inflowM3s === null &&
      outflowM3s === null
    ) {
      continue;
    }

    rows.push({ ishikawaName, observedAt, waterLevelM, storageVolumeM3, inflowM3s, outflowM3s });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '石川県河川総合情報システム ダム諸量 — 11 県管理ダム hourly JSON',
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
  ishikawaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.ishikawaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.ishikawaName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.ishikawaName}"`);
      continue;
    }
    out.push({ ishikawaName: r.ishikawaName, damId: best.id });
  }

  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const url = buildUrl(new Date(), BASE_URL);
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

  const json = (await r.json()) as IshikawaJson;
  const rows = parseIshikawaJson(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.ishikawaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.ishikawaName);
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
