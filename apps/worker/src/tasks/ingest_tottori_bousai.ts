// apps/worker/src/tasks/ingest_tottori_bousai.ts
//
// 鳥取県防災Web dam telemetry.
//
// Source: https://www.bousai.pref.tottori.lg.jp (Remix SPA, same framework as
// 広島県防災Web). Pointer → list JSON pattern:
//
//   /data/dam/data.json                    → { latestDateTimestamp }
//   /data/dam/list/{YYYY-MM-DD-HH-mm}.json → { items: [...] }
//
// 6 dams total (prefectural mgr=40 + mgr=41):
//   百谷/佐治川/東郷/賀祥/朝鍋 → already in tottori-dam (priority 307)
//   菅沢                        → new coverage (not in tottoridam.jp)
//
// source_priorities: tottori-bousai=312 outranks tottori-dam=307 and
// cgr-mlit-dam=304 (priority DESC wins), so it is the chart source for all 6.
//
// damEffectiveStorageQuantities is in 千m³ (× 1000 → m³); confirmed by
// 菅沢: 10,604 千m³ = 61.7% of 17,200,000 m³ effective capacity.
//
// Some items are not the dam's own telemetry, and all carry flag "0" (normal):
//   - incomplete hourly lists (total=2 — 朝鍋 + 菅沢 — instead of 6, ~2 a day
//     in September 2026) hold a 朝鍋 placeholder reading 0 m / 0 千m³, and at
//     times a 菅沢 item copying it field for field;
//   - complete lists sometimes hold a 菅沢 item copying 朝鍋's real values
//     (list 2026-09-27-05-20: both 102.89 m / 280 千m³ / 24 %).
// Each such item prints its own 最低水位 (97.0 m for 朝鍋, 353.1 m for 菅沢),
// and its level sits far below it. Stored as-is they were 423 prod rows of
// plunges on the chart (cleaned by deploy/ops/oneoff/
// 2026-09-28_tottori_bousai_placeholders.sql), so an item whose level is more
// than MIN_LEVEL_MARGIN_M below its own 最低水位 is skipped whole — its rate
// and flows are another dam's too.
//
// Cron: hourly at :33.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.TOTTORI_BOUSAI_URL ?? 'https://www.bousai.pref.tottori.lg.jp';
const PREF_CODE = '31';
const SOURCE_ID = 'tottori-bousai';

interface TottoriBousaiItem {
  name: string;
  observatoryId: number;
  managerCd: string;
  dataTimestamp: string;
  damQuantitiesLevel: number | null;
  damQuantitiesLevelFlg: string;
  damInflowQuantities: number | null;
  damInflowQuantitiesFlg: string;
  damTotalReleaseQuantities: number | null;
  damTotalReleaseQuantitiesFlg: string;
  damEffectiveStorageQuantities: number | null;
  damEffectiveStorageQuantitiesFlg: string;
  storageRateEffectiveCapacity: number | null;
  storageRateEffectiveCapacityFlg: string;
  storageRateWaterUseCapacity: number | null;
  storageRateWaterUseCapacityFlg: string;
  /** 最低水位 [EL.m] of the dam, printed on every item. */
  minWaterLevel: number | null;
}

export interface ParsedRow {
  observatoryId: string;
  observatoryName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

/** Parse 「YYYY-MM-DD HH:MM:SS」 (JST) → UTC Date. */
export function parseTottoriTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(
    Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]) - 9,
      Number(m[5]),
      Number(m[6]),
    ),
  );
}

/** Strip ダム suffix and （再）/（元）annotations. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

function gated(value: number | null, flg: string): number | null {
  return flg === '0' && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** How far below its own 最低水位 a level may read before the item is taken
 *  for another dam's data. Every real prod reading since 2026-06-05 is above
 *  最低水位 (closest: 百谷 62.37 vs 60.4 m); the placeholders and copies sit
 *  97–353 m below it. */
const MIN_LEVEL_MARGIN_M = 20;

/** Convert feed items to observation rows, dropping all-null dams and items
 *  that carry another dam's (or placeholder) values (see header). */
export function parseTottoriItems(items: TottoriBousaiItem[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const it of items) {
    const observedAt = parseTottoriTimestamp(it.dataTimestamp ?? '');
    if (!observedAt) continue;
    if (
      it.damQuantitiesLevel != null &&
      it.minWaterLevel != null &&
      it.damQuantitiesLevel < it.minWaterLevel - MIN_LEVEL_MARGIN_M
    )
      continue;

    const level = gated(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
    const inflow = gated(it.damInflowQuantities, it.damInflowQuantitiesFlg);
    const outflow = gated(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
    const storageThouM3 = gated(
      it.damEffectiveStorageQuantities,
      it.damEffectiveStorageQuantitiesFlg,
    );
    const storage = storageThouM3 != null ? storageThouM3 * 1000 : null;
    // Prefer 利水容量貯水率: it is the rate the manager publishes, against the
    // current-season 利水容量. 有効容量貯水率 divides by the full 有効貯水容量
    // and understates flood-control dams — the inversion issue #19 found in
    // kasenbosai. tottori-bousai is trusted_rate_basis (migration 0040), so the
    // stored rate is also back-solved into the denominator the API reports.
    // Today every dam reports the 利水 column as null/flg=2, so this is a
    // no-op until 鳥取県 starts publishing it.
    const ratePct =
      gated(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg) ??
      gated(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg);

    if (level == null && inflow == null && outflow == null && storage == null && ratePct == null) {
      continue;
    }

    out.push({
      observatoryId: String(it.observatoryId),
      observatoryName: it.name,
      observedAt,
      waterLevelM: level,
      inflowM3s: inflow,
      outflowM3s: outflow,
      storageVolumeM3: storage,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 312,
            '鳥取県防災Web — hourly, 6ダム (百谷/佐治川/東郷/賀祥/朝鍋/菅沢; JSON feed)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  observatoryId: string;
  damId: bigint;
}

export function chooseMaster(
  stem: string,
  masters: BindableMaster[],
  stationKey?: string,
): bigint | null {
  // A row already stamped with this observatory keeps it (#57).
  const stamped = stationKey ? stampedMaster(masters, stationKey) : null;
  if (stamped) return stamped.id;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (m.name === `${stem}ダム`) rank = 1;
    else if (mStem.startsWith(stem)) rank = 2;
    else if (mStem.includes(stem)) rank = 3;
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
    const stem = normalizeName(r.observatoryName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters, r.observatoryId);
    universe.push({
      externalId: r.observatoryId,
      name: r.observatoryName,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.observatoryName} (${r.observatoryId})`);
      continue;
    }
    out.push({ observatoryId: r.observatoryId, damId });
    await bindExternalId(damId, SOURCE_ID, r.observatoryId);
  }
  await recordUniverse(SOURCE_ID, universe);
  return out;
}

async function fetchJson<T>(path: string, ua: string): Promise<T | null> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) return null;
  return (await res.json()) as T;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const pointer = await fetchJson<{ latestDateTimestamp: string }>('/data/dam/data.json', ua);
  const latest = pointer?.latestDateTimestamp;
  if (!latest) {
    log(`${SOURCE_ID}: could not read latestDateTimestamp; abort`);
    return;
  }
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const snapshot = await fetchJson<{ items: TottoriBousaiItem[] }>(
    `/data/dam/list/${slug}.json`,
    ua,
  );
  if (!snapshot?.items) {
    log(`${SOURCE_ID}: snapshot ${slug} missing items; abort`);
    return;
  }

  const parsed = parseTottoriItems(snapshot.items);
  log(`${SOURCE_ID}: parsed ${parsed.length}/${snapshot.items.length} dams at ${latest}`);

  const matches = await matchMaster(parsed, log);
  const damByObs = new Map(matches.map((m) => [m.observatoryId, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByObs.get(p.observatoryId);
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
  log(`${SOURCE_ID} done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
