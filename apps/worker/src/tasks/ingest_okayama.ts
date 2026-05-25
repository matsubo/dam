// apps/worker/src/tasks/ingest_okayama.ts
//
// Phase B2 (#6): おかやま防災ポータル prefectural dam telemetry.
//
// Source: https://www.bousai.pref.okayama.jp (Dojo SPA). The SPA reads a
// flat-file JSON feed published every 30 minutes:
//
//   data/damQuantities/data.json            → { latestDateTimestamp }
//   data/damQuantities/list/{YYYY-MM-DD-HH-MM}.json → { items: [...] }
//
// Each item carries the dam's current values plus a per-field "Flg" where
// "0" means the value is valid and anything else (2/4) means no telemetry.
// 21 dams are listed; ~15 report a storage value at any given fetch (the
// rest are seasonally empty or untelemetered). 苫田ダム(国) is also covered
// by cgr-mlit-dam at higher priority — source_priorities resolves the
// overlap, so we ingest it here too without special-casing.
//
// Values:
//   damQuantitiesLevel            → water level (m)
//   damInflowQuantities           → inflow (m³/s)
//   damTotalReleaseQuantities     → outflow (m³/s)
//   damEffectiveStorageQuantities → effective storage (m³, already absolute)
//   storageRateEffectiveCapacity  → % of effective capacity (often absent);
//     fall back to storageRateWaterUseCapacity (利水貯水率), which the
//     portal itself surfaces as the headline 貯水率 for most dams.
//
// Cron: hourly at :21 (feed refreshes every 30 min; we take the freshest
// snapshot and spread load away from the other prefectural sources).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.OKAYAMA_DAM_URL ?? 'https://www.bousai.pref.okayama.jp';
const PREF_CODE = '33';
const SOURCE_ID = 'okayama-bousai';

interface OkayamaItem {
  name: string;
  observatoryId: string;
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
  dataTimestamp: string;
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
export function parseOkayamaTimestamp(s: string): Date | null {
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

/**
 * Fold visually-identical kanji variants that differ only by codepoint so
 * the feed and the master compare equal. 槇 (U+69C7) vs 槙 (U+69D9) is the
 * one pair seen in 岡山 (槙谷ダム ↔ master 槇谷); extend the maps in tandem
 * if more surface.
 */
function foldVariants(s: string): string {
  return s.replace(/槇/g, '槙');
}

/** Strip the ダム suffix and (国)/（再）/（元）-style annotations, fold kanji variants. */
export function normalizeName(s: string): string {
  return foldVariants(
    s
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/ダム$/, '')
      .trim(),
  );
}

/** A field value is only trustworthy when its companion Flg is "0". */
function gated(value: number | null, flg: string): number | null {
  return flg === '0' && typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Convert the feed's items into observation rows, dropping dams that report
 * no usable value (every gated field null).
 */
export function parseOkayamaItems(items: OkayamaItem[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const it of items) {
    const observedAt = parseOkayamaTimestamp(it.dataTimestamp ?? '');
    if (!observedAt) continue;

    const level = gated(it.damQuantitiesLevel, it.damQuantitiesLevelFlg);
    const inflow = gated(it.damInflowQuantities, it.damInflowQuantitiesFlg);
    const outflow = gated(it.damTotalReleaseQuantities, it.damTotalReleaseQuantitiesFlg);
    const storage = gated(it.damEffectiveStorageQuantities, it.damEffectiveStorageQuantitiesFlg);
    const ratePct =
      gated(it.storageRateEffectiveCapacity, it.storageRateEffectiveCapacityFlg) ??
      gated(it.storageRateWaterUseCapacity, it.storageRateWaterUseCapacityFlg);

    if (level == null && inflow == null && outflow == null && storage == null && ratePct == null) {
      continue;
    }

    out.push({
      observatoryId: it.observatoryId,
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
    VALUES (${SOURCE_ID}, 309,
            'おかやま防災ポータル — hourly, ~15 県管理ダム (JSON feed, 30分更新)',
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
 * Pick the best master dam for a feed name. Both sides are normalized
 * identically (strip ダム + （...） annotations, fold 槇→槙) so an exact stem
 * match wins over a substring collision such as 黒谷 grabbing 黒谷池（元）
 * instead of the intended 黒谷（再）.
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

  const pointer = await fetchJson<{ latestDateTimestamp: string }>(
    `/data/damQuantities/data.json?request.preventCache=${Date.now()}`,
    ua,
  );
  const latest = pointer?.latestDateTimestamp;
  if (!latest) {
    log(`${SOURCE_ID}: could not read latestDateTimestamp; abort`);
    return;
  }
  // 「2026-05-25 11:30:00」 → list/2026-05-25-11-30.json
  const slug = latest.slice(0, 16).replace(/[ :]/g, '-');
  const snapshot = await fetchJson<{ items: OkayamaItem[] }>(
    `/data/damQuantities/list/${slug}.json`,
    ua,
  );
  if (!snapshot?.items) {
    log(`${SOURCE_ID}: snapshot ${slug} missing items; abort`);
    return;
  }

  const parsed = parseOkayamaItems(snapshot.items);
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
