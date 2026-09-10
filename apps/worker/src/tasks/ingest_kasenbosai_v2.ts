// apps/worker/src/tasks/ingest_kasenbosai_v2.ts
//
// Phase A2 (#3): consume 川の防災情報 (MLIT SCC) per-dam value JSON for
// every master dam that has `external_ids.kasenbosai` set.
//
// Per-dam value endpoint (discovered by Playwright network capture):
//
//   /kawabou/file/files/tmlist/dam/{YYYYMMDD}/{HHMM}/{obs_fcd}.json
//
// Response shape:
//   { dspFlg, obsValue: {
//       storLvl: number (m),       — 貯水位
//       storCap: number (千m³),     — 貯水量
//       storPcntIrr: number (%),    — 利水容量貯水率 (preferred, see #19)
//       storPcntEff: number (%),    — 有効容量貯水率 (fallback only)
//       allSink: number (m³/s),     — 全流入量
//       allDisch: number (m³/s),    — 全放流量
//       obsTime: "YYYY/MM/DD HH:MM" (JST),
//       damdschLvl, damdschFgrNm, ...
//     },
//     min10Values: [...latest 24h at 10-min cadence...],
//     hrValues: [...hourly...] }
//
// We upsert one observation per dam per cron firing (the latest obsValue).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.KASENBOSAI_TM_BASE ?? 'https://www.river.go.jp/kawabou/file/files/tmlist/dam';

const SOURCE_ID = 'kasenbosai';

const CONCURRENCY = Number(process.env.KASENBOSAI_CONCURRENCY ?? '8');
const PER_REQUEST_TIMEOUT_MS = 10_000;
const INTER_REQUEST_DELAY_MS = 50;

export interface ApiObsValue {
  storLvl?: number | null;
  storLvlCcd?: number | null;
  storCap?: number | null;
  storCapCcd?: number | null;
  storPcntIrr?: number | null;
  storPcntIrrCcd?: number | null;
  storPcntEff?: number | null;
  storPcntEffCcd?: number | null;
  allSink?: number | null;
  allSinkCcd?: number | null;
  allDisch?: number | null;
  allDischCcd?: number | null;
  obsTime?: string;
}
interface ApiResponse {
  dspFlg?: number;
  obsValue?: ApiObsValue;
}

interface DamTarget {
  damId: bigint;
  obsFcd: string;
  /** 有効貯水容量, used to sanity-check a published 'eff' rate. */
  effectiveCapacityM3: number | null;
}

function userAgent(): string {
  return (
    process.env.HTTP_USER_AGENT ??
    process.env.KASENBOSAI_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)'
  );
}

function jstNowParts(): { date: string; time: string } {
  const now = new Date(Date.now() + 9 * 3_600_000);
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  // SCC files publish at 10-minute boundaries; snap DOWN to the previous
  // multiple of 10 minutes, then back off another 10 so the file is
  // reliably published by the time we ask for it.
  const m = Math.max(0, Math.floor(now.getUTCMinutes() / 10) * 10 - 10);
  const mi = String(m).padStart(2, '0');
  return { date: `${yyyy}${mm}${dd}`, time: `${hh}${mi}` };
}

/** Parse "2026/05/19 17:30" (JST) → UTC Date. */
export function parseKasenbosaiTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})[ T](\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

function numOrNull(v: number | null | undefined): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v;
}

/**
 * A value only counts when its per-field quality code (Ccd) is 0 or absent.
 * The feed reports missing 貯水量/貯水率 as value 0 with Ccd=160 — taking
 * those at face value stored phantom "empty reservoir" observations.
 */
function validOrNull(v: number | null | undefined, ccd: number | null | undefined): number | null {
  if (ccd != null && ccd !== 0) return null;
  return numOrNull(v);
}

export interface ParsedKasenbosaiObs {
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  /**
   * Which denominator `storageRate` was published against: 利水容量 ('irr') or
   * 有効貯水容量 ('eff'), null when no rate survived the quality codes. Only
   * 'eff' can be checked against the master, since 利水容量 is seasonal and the
   * static master value doesn't track it — see #17.
   */
  rateBasis: 'irr' | 'eff' | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  waterLevelM: number | null;
}

/** An 'eff' rate may disagree with volume/有効貯水容量 by this much and still stand. */
const EFF_RATE_TOLERANCE = 0.15;

/**
 * Drop a published 有効貯水容量 rate that its own volume contradicts.
 *
 * 合角ダム and 有間ダム flag storPcntIrr invalid (Ccd=160) and then publish
 * storPcntEff = 100 with Ccd=0 while sitting under half full — 合角 held
 * 4,135 千m³ against a 9,250 千m³ 有効貯水容量, a real 44.7 %. Ccd says the value
 * is good, so nothing upstream catches it and every 貯水率 on the site read
 * 100 %. Same family as the Ccd=160 phantom zeros migrations 0038/0039 cleaned
 * up, just in the rate field rather than the volume field.
 *
 * Checking against the dam's own 有効貯水容量 rather than testing for `=== 100`
 * keeps a genuinely full reservoir intact. 'irr' rates are returned untouched:
 * a dam at 100 % of its 洪水期 利水容量 legitimately holds far less than its
 * 有効貯水容量 (浦山 was 100 % Irr at 61.7 % Eff), and those rates may exceed
 * 100 % while the flood pool fills.
 */
export function rateIfConsistent(
  parsed: ParsedKasenbosaiObs,
  effectiveCapacityM3: number | null | undefined,
): number | null {
  const { storageRate, storageVolumeM3, rateBasis } = parsed;
  if (storageRate == null || rateBasis !== 'eff') return storageRate;
  if (!effectiveCapacityM3 || effectiveCapacityM3 <= 0) return storageRate;
  if (storageVolumeM3 == null) return storageRate;
  const implied = storageVolumeM3 / effectiveCapacityM3;
  return Math.abs(implied - storageRate) > EFF_RATE_TOLERANCE ? null : storageRate;
}

export function parseKasenbosaiObsValue(ov: ApiObsValue): ParsedKasenbosaiObs | null {
  if (!ov.obsTime) return null;
  const observedAt = parseKasenbosaiTimestamp(ov.obsTime);
  if (!observedAt) return null;
  // Convert vol from 千m³ → m³.
  const storCap = validOrNull(ov.storCap, ov.storCapCcd);
  // Prefer 利水容量貯水率 (storPcntIrr): it is the rate the dam manager
  // publishes, with the current-season 利水容量 as denominator (much smaller
  // in 洪水期 for flood-control dams). storPcntEff divides by the full
  // 有効貯水容量 and does not match this site's 貯水率 definition — see #19
  // (美利河ダム: Irr 92.3% vs Eff 13.5% on the same reading). Fall back to
  // storPcntEff only when 利水 is missing. Convert % → fraction. No clamp:
  // 利水 rates legitimately exceed 100% while the flood pool fills.
  const irrPct = validOrNull(ov.storPcntIrr, ov.storPcntIrrCcd);
  const effPct = irrPct == null ? validOrNull(ov.storPcntEff, ov.storPcntEffCcd) : null;
  const ratePct = irrPct ?? effPct;
  const storageRate = ratePct != null ? ratePct / 100 : null;
  // Which denominator the rate came from — rateIfConsistent() can only check
  // the 'eff' ones against the master.
  const rateBasis: 'irr' | 'eff' | null = irrPct != null ? 'irr' : effPct != null ? 'eff' : null;
  // A storCap of exactly 0 with no corroborating rate is kasenbosai's
  // "this dam doesn't publish volume" placeholder (e.g. 大峠ダム — reports
  // level + flow but storCap=0/Ccd=0 while both rate fields are missing),
  // not a real empty reservoir. A genuinely empty dam reports a valid 0%
  // rate alongside the 0, so keep it only when the rate corroborates.
  const storageVolumeM3 =
    storCap == null || (storCap === 0 && storageRate == null) ? null : storCap * 1000;
  return {
    observedAt,
    storageVolumeM3,
    storageRate,
    rateBasis,
    inflowM3s: validOrNull(ov.allSink, ov.allSinkCcd),
    outflowM3s: validOrNull(ov.allDisch, ov.allDischCcd),
    waterLevelM: validOrNull(ov.storLvl, ov.storLvlCcd),
  };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 310,
            '国土交通省 川の防災情報 (MLIT SCC) — 全国 800+ ダム / 10-min cadence per-dam JSON',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function loadTargets(): Promise<DamTarget[]> {
  const rows = await sql<{ id: bigint; obs_fcd: string; effective_capacity_m3: string | null }[]>`
    SELECT id, external_ids->>'kasenbosai' AS obs_fcd,
           effective_capacity_m3::TEXT AS effective_capacity_m3
    FROM dams
    WHERE external_ids ? 'kasenbosai'
      AND external_ids->>'kasenbosai' ~ '^[0-9]{13}$'
    ORDER BY id
  `;
  return rows.map((r) => ({
    damId: r.id,
    obsFcd: r.obs_fcd,
    effectiveCapacityM3: r.effective_capacity_m3 == null ? null : Number(r.effective_capacity_m3),
  }));
}

async function fetchOne(
  target: DamTarget,
  date: string,
  time: string,
  ua: string,
): Promise<Parameters<typeof upsertObservations>[0][number] | null> {
  const url = `${BASE_URL}/${date}/${time}/${target.obsFcd}.json`;
  const r = await fetch(url, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (r.status === 404) return null; // dam may have no current value
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (!text || text.length < 5) return null;
  let payload: ApiResponse;
  try {
    payload = JSON.parse(text) as ApiResponse;
  } catch {
    return null;
  }
  const ov = payload.obsValue;
  if (!ov) return null;
  const parsed = parseKasenbosaiObsValue(ov);
  if (!parsed) return null;
  const { rateBasis: _rateBasis, ...obs } = parsed;
  return {
    ...obs,
    storageRate: rateIfConsistent(parsed, target.effectiveCapacityM3),
    damId: target.damId,
    sourceId: SOURCE_ID,
    rainfallMm: null,
    rawSnapshotId: null,
    qualityFlag: 0,
  };
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const targets = await loadTargets();
  if (targets.length === 0) {
    log(`${SOURCE_ID}: no targets (run match:kasenbosai first)`);
    return;
  }
  const { date, time } = jstNowParts();
  log(`${SOURCE_ID}: fetching ${targets.length} dams for ${date} ${time}`);
  const ua = userAgent();

  // Process in small concurrent batches so an upstream slowdown on a few
  // dams doesn't serialise the entire run.
  const batch = [] as DamTarget[][];
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    batch.push(targets.slice(i, i + CONCURRENCY));
  }
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let okCount = 0;
  let noneCount = 0;
  let errCount = 0;
  for (const group of batch) {
    const settled = await Promise.allSettled(group.map((t) => fetchOne(t, date, time, ua)));
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        if (s.value == null) {
          noneCount += 1;
        } else {
          okCount += 1;
          inputs.push(s.value);
        }
      } else {
        errCount += 1;
      }
    }
    if (INTER_REQUEST_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, INTER_REQUEST_DELAY_MS));
    }
  }
  // Bulk upsert in 1k-row chunks.
  let written = 0;
  const CHUNK = 1_000;
  for (let i = 0; i < inputs.length; i += CHUNK) {
    written += await upsertObservations(inputs.slice(i, i + CHUNK));
  }
  log(
    `${SOURCE_ID} done: targets=${targets.length} ok=${okCount} none=${noneCount} err=${errCount} written=${written}`,
  );
};

export default task;
