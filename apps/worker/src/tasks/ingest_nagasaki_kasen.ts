// apps/worker/src/tasks/ingest_nagasaki_kasen.ts
//
// 長崎県河川砂防情報 ダム情報 — 35 ダム, 30分更新.
//
// Source:
//   https://dam.pref.nagasaki.jp/data/dt_range.json  → max_dt (JST)
//   https://dam.pref.nagasaki.jp/data/dam_m.json     → dam master (dam_cd → name)
//   https://dam.pref.nagasaki.jp/data/all/{ym}/{ymd}/all_{ymd}_{hm}_d.json
// Format: UTF-8 JSON. All times in JST.
// Fields per dam: lv(m), pondage(千m³), rate(%), in(m³/s), dis(m³/s).
// Priority 308, matching other prefectural sources.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.NAGASAKI_KASEN_BASE_URL ?? 'https://dam.pref.nagasaki.jp';

const PREF_CODE = '42';
const SOURCE_ID = 'nagasaki-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  damCd: number;
  damName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

interface DtRange {
  min_dt: string;
  max_dt: string;
}

interface DamMaster {
  dam_cd: number;
  dam_nm: string;
}

interface DamDataItem {
  dam_cd: number;
  lv: string;
  pondage: string;
  rate: string;
  in: string;
  dis: string;
}

interface AllDamsJson {
  ymd: string;
  time: string;
  list: DamDataItem[];
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD" + "HH:MM" JST → UTC Date */
export function parseNagasakiDatetime(ymd: string, time: string): Date | null {
  const m1 = ymd.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const m2 = time.match(/^(\d{2}):(\d{2})$/);
  if (!m1 || !m2) return null;
  const d = new Date(
    Date.UTC(
      Number(m1[1]),
      Number(m1[2]) - 1,
      Number(m1[3]),
      Number(m2[1]) - 9,
      Number(m2[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const clean = s.trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Build the all-dams snapshot URL from a JST max_dt string "YYYY/MM/DD HH:MM:SS" */
export function buildSnapshotUrl(base: string, maxDt: string): string | null {
  const m = maxDt.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):/);
  if (!m) return null;
  const ym = `${m[1]}${m[2]}`;
  const ymd = `${m[1]}${m[2]}${m[3]}`;
  const hm = `${m[4]}${m[5]}`;
  return `${base}/data/all/${ym}/${ymd}/all_${ymd}_${hm}_d.json`;
}

export function parseAllDamsJson(raw: AllDamsJson, masters: Map<number, string>): ParsedRow[] {
  const observedAt = parseNagasakiDatetime(raw.ymd, raw.time);
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];
  for (const item of raw.list) {
    const name = masters.get(item.dam_cd);
    if (!name) continue;

    const pondageRaw = parseNum(item.pondage);
    rows.push({
      damCd: item.dam_cd,
      damName: name,
      observedAt,
      waterLevelM: parseNum(item.lv),
      storageVolumeM3: pondageRaw !== null ? pondageRaw * 1_000 : null,
      storageRate: (() => {
        const r = parseNum(item.rate);
        return r !== null ? r / 100 : null;
      })(),
      inflowM3s: parseNum(item.in),
      outflowM3s: parseNum(item.dis),
    });
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '長崎県河川砂防情報 ダム情報 — 35 ダム (JSON, 30分更新)',
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
  damCd: number;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.damName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.damName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.damName}" (dam_cd=${r.damCd})`);
      continue;
    }

    out.push({ damCd: r.damCd, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${String(r.damCd)}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${String(r.damCd)}
    `;
  }

  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const headers = {
    'user-agent':
      process.env.HTTP_USER_AGENT ??
      'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
  };
  const signal = AbortSignal.timeout(20_000);

  // 1. Fetch date range to get max_dt
  const rangeRes = await fetch(`${BASE_URL}/data/dt_range.json`, { headers, signal });
  if (rangeRes.status !== 200) {
    log(`${SOURCE_ID}: dt_range.json HTTP ${rangeRes.status}; aborting`);
    return;
  }
  const range = (await rangeRes.json()) as DtRange;
  const snapshotUrl = buildSnapshotUrl(BASE_URL, range.max_dt);
  if (!snapshotUrl) {
    log(`${SOURCE_ID}: cannot build snapshot URL from max_dt="${range.max_dt}"`);
    return;
  }

  // 2. Fetch dam master
  const masterRes = await fetch(`${BASE_URL}/data/dam_m.json`, { headers, signal });
  if (masterRes.status !== 200) {
    log(`${SOURCE_ID}: dam_m.json HTTP ${masterRes.status}; aborting`);
    return;
  }
  const masterList = (await masterRes.json()) as DamMaster[];
  const masterMap = new Map<number, string>(masterList.map((m) => [m.dam_cd, m.dam_nm]));

  // 3. Fetch snapshot
  const snapRes = await fetch(snapshotUrl, { headers, signal });
  if (snapRes.status !== 200) {
    log(`${SOURCE_ID}: snapshot HTTP ${snapRes.status} for ${snapshotUrl}; aborting`);
    return;
  }
  const allDams = (await snapRes.json()) as AllDamsJson;
  const rows = parseAllDamsJson(allDams, masterMap);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows from ${snapshotUrl}`);

  const matches = await matchMaster(rows, log);
  const damByCd = new Map(matches.map((m) => [m.damCd, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByCd.get(p.damCd);
    if (!damId) continue;
    if (p.waterLevelM === null && p.storageVolumeM3 === null) continue;

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
