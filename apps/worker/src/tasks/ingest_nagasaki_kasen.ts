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

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
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
  /**
   * source_universe.has_data: true = the task stores the row (a level or a
   * volume); false = the provider prints its 「-」 in every field (樋口 /
   * つづら / 笛吹, stat 0); null = an empty or unreadable field, which may be
   * our parser rather than the provider.
   */
  hasData: boolean | null;
}

interface DtRange {
  min_dt: string;
  max_dt: string;
}

export interface DamMaster {
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
    const waterLevelM = parseNum(item.lv);
    const storageVolumeM3 = pondageRaw !== null ? pondageRaw * 1_000 : null;
    const empty = [item.lv, item.pondage, item.rate, item.rate_r, item.rate_y, item.in, item.dis]
      .filter((v) => v !== undefined)
      .every((v) => v.trim() === '-');
    rows.push({
      damCd: item.dam_cd,
      damName: name,
      observedAt,
      waterLevelM,
      storageVolumeM3,
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
      hasData: waterLevelM !== null || storageVolumeM3 !== null ? true : empty ? false : null,
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

/**
 * Stations the name rule binds wrongly, by dam_cd, pinned to an NDI row.
 *
 * 1106 「小ヶ倉ダム」 → 小ヶ倉 (NDI 2609), 長崎市's dam on the 鹿尾川 — pref 42
 * has a second 小ヶ倉 (NDI 2592, 諫早市), and the lower id picked that one. The
 * 11xx codes are the 長崎市 block (式見, 鹿尾, 本河内…), and on prod every one
 * of the 2,738 readings the station shares an instant with kasenbosai's
 * 「小ヶ倉(補助)ダム」 (bound to 2609) carries the same 貯水位 (87.97–90.89 m;
 * kasenbosai on 2592 reads 0–26 m); mudam's listing 524 is pinned to 2609 too
 * (migration 0073).
 */
const NDI_PINS: Readonly<Record<number, string>> = {
  1106: '2609',
};

export interface NagasakiMaster extends BindableMaster {
  ndi: string | null;
}

/** The pref-42 master for a station: its NDI pin, else its stamp, else by name. */
export function chooseMaster(
  damCd: number,
  damName: string,
  masters: NagasakiMaster[],
): NagasakiMaster | null {
  const pin = NDI_PINS[damCd];
  if (pin) return masters.find((m) => m.ndi === pin) ?? null;
  const stamped = stampedMaster(masters, String(damCd));
  if (stamped) return stamped;

  const stem = normalizeName(damName);
  if (!stem) return null;
  let best: { m: NagasakiMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === damName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m ?? null;
}

interface DamMatch {
  damCd: number;
  damId: bigint;
}

interface MasterMatches {
  matches: DamMatch[];
  /** Every pref-42 master already stamped with a nagasaki-kasen dam_cd. */
  byExternalId: Map<number, bigint>;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<MasterMatches> {
  // The stamp is how a dam whose name differs from the master keeps its
  // binding (け知ダム, stamped dam_cd=2030 by a migration).
  const masters = await sql<NagasakiMaster[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>'ndi' AS ndi, external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const byExternalId = new Map<number, bigint>(
    masters.filter((m) => m.stamp && /^\d+$/.test(m.stamp)).map((m) => [Number(m.stamp), m.id]),
  );
  const out: DamMatch[] = [];

  for (const r of rows) {
    const m = chooseMaster(r.damCd, r.damName, masters);
    if (!m) {
      log(`${SOURCE_ID}: no master match for "${r.damName}" (dam_cd=${r.damCd})`);
      continue;
    }
    out.push({ damCd: r.damCd, damId: m.id });
    if (m.stamp !== String(r.damCd)) await bindExternalId(m.id, SOURCE_ID, String(r.damCd));
  }

  return { matches: out, byExternalId };
}

/**
 * What 長崎県 publishes, built from `dam_m.json` — the provider's own
 * catalogue — rather than from the snapshot rows that happened to carry a
 * reading. A dam whose gauge is silent this run is still published, and
 * recording only the readable ones would let it read as published by nobody.
 *
 * `dam_cd` is the upstream's stable id, so it is the external id; unmatched
 * dams stay in the list with a null `resolvedDamId` as matching backlog.
 * `hasData` is the snapshot row's; a catalogued dam without one is unknown.
 */
export function buildNagasakiUniverse(
  catalogue: DamMaster[],
  resolve: (damCd: number) => bigint | undefined,
  snapshot: ParsedRow[],
): UniverseRow[] {
  const hasData = new Map(snapshot.map((r) => [r.damCd, r.hasData]));
  return catalogue.map((m) => ({
    externalId: String(m.dam_cd),
    name: m.dam_nm,
    prefCode: PREF_CODE,
    resolvedDamId: resolve(m.dam_cd) ?? null,
    hasData: hasData.get(m.dam_cd) ?? null,
  }));
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

  const { matches, byExternalId } = await matchMaster(rows, log);
  const damByCd = new Map(matches.map((m) => [m.damCd, m.damId]));

  // A catalogued dam missing from this snapshot is absent from `damByCd`, but
  // its master may already carry the stamp — resolve it rather than record a
  // bound, published dam as unmatched backlog (#82).
  await recordUniverse(
    SOURCE_ID,
    buildNagasakiUniverse(
      masterList,
      (damCd) => damByCd.get(damCd) ?? byExternalId.get(damCd),
      rows,
    ),
  );

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
