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
// source_priorities: tottori-dam=307 wins for the 5 overlapping dams;
// tottori-bousai=312 becomes preferredSource only for 菅沢.
//
// damEffectiveStorageQuantities is in 千m³ (× 1000 → m³); confirmed by
// 菅沢: 10,604 千m³ = 61.7% of 17,200,000 m³ effective capacity.
//
// Cron: hourly at :33.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
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

/** Convert feed items to observation rows, dropping all-null dams. */
export function parseTottoriItems(items: TottoriBousaiItem[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const it of items) {
    const observedAt = parseTottoriTimestamp(it.dataTimestamp ?? '');
    if (!observedAt) continue;

    const level = gated(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
    const inflow = gated(it.damInflowQuantities, it.damInflowQuantitiesFlg);
    const outflow = gated(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
    const storageThouM3 = gated(
      it.damEffectiveStorageQuantities,
      it.damEffectiveStorageQuantitiesFlg,
    );
    const storage = storageThouM3 != null ? storageThouM3 * 1000 : null;
    const ratePct =
      gated(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg) ??
      gated(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg);

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

export function chooseMaster(stem: string, masters: { id: bigint; name: string }[]): bigint | null {
  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (m.name === `${stem}ダム`) rank = 1;
    else if (mStem.startsWith(stem)) rank = 2;
    else if (mStem.includes(stem)) rank = 3;
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
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.observatoryName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
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
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.observatoryId}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.observatoryId}
    `;
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
