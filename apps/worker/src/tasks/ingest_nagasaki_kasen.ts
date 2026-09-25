// apps/worker/src/tasks/ingest_nagasaki_kasen.ts
//
// 長崎県河川砂防情報 ダム情報 — 35 ダム, 30分更新.
//
// Source:
//   https://dam.pref.nagasaki.jp/data/dt_range.json  → max_dt (JST)
//   https://dam.pref.nagasaki.jp/data/dam_m.json     → dam master (dam_cd → name)
//   https://dam.pref.nagasaki.jp/data/all/{ym}/{ymd}/all_{ymd}_{hm}_d.json
// Format: UTF-8 JSON. All times in JST.
// Fields per dam: lv(m), pondage(千m³), in(m³/s), dis(m³/s) and three rates —
// rate_r (利水容量貯水率), rate_y (有効容量貯水率) and rate, which tracks
// rate_y. 長崎県 publishes 利水容量 and 有効貯水容量 separately in dam_m.json
// (tank_risui_d / tank_ecapa), and this site's 貯水率 is the 利水 one.
// Priority 308, matching other prefectural sources.

import { type BindableMaster, preferMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
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
  /** 貯水率 — the feed's headline rate, on the same basis as rate_y. */
  rate: string;
  /** 利水容量貯水率 (%). */
  rate_r?: string;
  /** 有効容量貯水率 (%). */
  rate_y?: string;
  pondage: string;
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
  // Volumes ≥ 1,000 千m³ arrive with a thousands separator ("1,938").
  const clean = s.trim().replace(/,/g, '');
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
      // Prefer 利水容量貯水率 (rate_r): it is the rate the manager publishes,
      // against the current-season 利水容量. rate / rate_y divide by the full
      // 有効貯水容量 and understate flood-control dams badly — 宮崎ダム reads
      // 17.5 % on 有効 against 100 % on 利水. Same inversion as issue #19
      // (kasenbosai) and commit ad2323d (cgr_mlit / kumamoto / kochi).
      storageRate: (() => {
        const r = parseNum(item.rate_r ?? '') ?? parseNum(item.rate_y ?? '') ?? parseNum(item.rate);
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
  // Load any dams that were pre-seeded with a nagasaki-kasen external_id
  // (e.g. け知ダム added via migration with dam_cd=2030).  Matching by
  // external_id is more reliable than name matching for dams whose name in
  // the JSON differs from the master.
  const seeded = await sql<{ id: bigint; damCd: number }[]>`
    SELECT id, (external_ids->>${SOURCE_ID})::int AS "damCd"
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND external_ids ? ${SOURCE_ID}
      AND external_ids->>${SOURCE_ID} ~ '^\\d+$'
  `;
  const byExternalId = new Map<number, bigint>(seeded.map((r) => [r.damCd, r.id]));

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear"
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    // Prefer pre-seeded external_id match (highest confidence).
    const seededId = byExternalId.get(r.damCd);
    if (seededId) {
      out.push({ damCd: r.damCd, damId: seededId });
      continue;
    }

    const stem = normalizeName(r.damName);
    if (!stem) continue;

    let best: { m: BindableMaster; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
        best = { m, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.damName}" (dam_cd=${r.damCd})`);
      continue;
    }

    out.push({ damCd: r.damCd, damId: best.m.id });
    await bindExternalId(best.m.id, SOURCE_ID, String(r.damCd));
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
