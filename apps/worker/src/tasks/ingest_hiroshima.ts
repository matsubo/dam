// apps/worker/src/tasks/ingest_hiroshima.ts
//
// Phase B5 (#9): 広島県防災Web prefectural dam telemetry.
//
// Source: https://www.bousai.pref.hiroshima.lg.jp (Remix SPA). The SPA reads
// a flat-file JSON feed published every 10 minutes:
//
//   /data/dam/data.json                     → { latestDateTimestamp }
//   /data/dam/list/{YYYY-MM-DD-HH-mm}.json  → { items: [...] }
//   /data/master/observatory/dam.json       → master list (static)
//
// The observation feed uses the same field schema as おかやま防災ポータル but
// damEffectiveStorageQuantities is in 千m³ (confirmed: 2651 千m³ = 26.8% of
// 9,900,000 m³ for 小瀬川ダム). Values carry per-field Flg codes where "0" =
// valid and anything else (1=欠, 2=未, 3=閉) means no data.
//
// 18 dams total; 12 prefectural (managerCd 23/24/26) + 5 MLIT (25) already
// covered by cgr-mlit-dam. All 18 report data every observation period. MLIT
// dams are ingested here too; source_priorities (cgr-mlit at 304, this source
// at 310) ensure cgr-mlit wins as preferredSource for those overlap dams.
//
// Metrics:
//   damQuantitiesLevel            → water level (m)
//   damInflowQuantities           → inflow (m³/s)
//   damTotalReleaseQuantities     → outflow (m³/s)
//   damEffectiveStorageQuantities → effective storage (千m³ → × 1000 = m³)
//   storageRateEffectiveCapacity  → % effective capacity
//     fallback: storageRateWaterUseCapacity (利水貯水率)
//
// Cron: hourly at :29.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.HIROSHIMA_DAM_URL ?? 'https://www.bousai.pref.hiroshima.lg.jp';
const PREF_CODE = '34';
const SOURCE_ID = 'hiroshima-bousai';

interface HiroshimaItem {
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
export function parseHiroshimaTimestamp(s: string): Date | null {
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

/** Strip ダム suffix and （再）/（元）-style annotations. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** A field value is only valid when its companion Flg is "0". */
function gated(value: number | null, flg: string): number | null {
  return flg === '0' && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Convert feed items to observation rows, dropping all-null dams. */
export function parseHiroshimaItems(items: HiroshimaItem[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const it of items) {
    const observedAt = parseHiroshimaTimestamp(it.dataTimestamp ?? '');
    if (!observedAt) continue;

    const level = gated(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
    const inflow = gated(it.damInflowQuantities, it.damInflowQuantitiesFlg);
    const outflow = gated(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
    // Storage unit is 千m³; convert to m³
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
    VALUES (${SOURCE_ID}, 310,
            '広島県防災Web — hourly, 18ダム (JSON feed, 10分更新)',
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

/**
 * Pick the best master dam for a feed name. Stems are normalized identically
 * (strip ダム + （...） annotations) so exact matches win over substrings.
 */
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
  for (const r of rows) {
    const stem = normalizeName(r.observatoryName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
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
  // 「2026-06-05 08:10:00」 → list/2026-06-05-08-10.json
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const snapshot = await fetchJson<{ items: HiroshimaItem[] }>(`/data/dam/list/${slug}.json`, ua);
  if (!snapshot?.items) {
    log(`${SOURCE_ID}: snapshot ${slug} missing items; abort`);
    return;
  }

  const parsed = parseHiroshimaItems(snapshot.items);
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
