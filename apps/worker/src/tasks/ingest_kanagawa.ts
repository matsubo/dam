// apps/worker/src/tasks/ingest_kanagawa.ts
//
// Fifth real-observation source. かながわの水がめ (kanagawa-dam.jp) is a
// JS-rendered SPA but its XHR endpoint is plain JSON, so we skip Playwright
// and hit it directly:
//
//   https://kanagawa-dam.jp/api/summary.php
//
// Payload (excerpt):
//   {
//     "lastUpdate": "2026-05-13",
//     "values": {
//       "sagami_volume": {"0":"26992", ..., "29":"32096", "dt":"2026-05-12 22:00"},
//       "sagami_storage_level": {...},          // 貯水率 %
//       "sagami_water_level": {...},            // 貯水位 EL.m
//       "sagami_in": {...},                     // 流入量 m³/s
//       "sagami_out": {...},                    // 放流量 m³/s
//       ... same shape for shiroyama / miho / miyagase / doushi
//     }
//   }
//
// All 5 dams are NEW — none were covered by tokyo-waterworks / jwa-junpo /
// aitoyo / jwa-chikugo. They're high-profile dams supplying the Kanagawa
// prefecture water system (~9 million people).
//
// Cadence: the dt field is per-FIELD (different sensors fire at different
// minutes); we use volume's dt as the canonical observed_at and write one
// observation per dam per fetch. Future task: a backfill that walks the
// 30-hour rolling window in the response and emits 30 rows per dam.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const API_URL = process.env.KANAGAWA_DAM_API ?? 'https://kanagawa-dam.jp/api/summary.php';

const NAME_MAP: Array<{ key: string; masterName: string; prefCodes: string[] }> = [
  { key: 'sagami', masterName: '相模', prefCodes: ['14'] },
  { key: 'shiroyama', masterName: '城山', prefCodes: ['14'] },
  { key: 'miho', masterName: '三保', prefCodes: ['14'] },
  { key: 'miyagase', masterName: '宮ヶ瀬', prefCodes: ['14'] },
  { key: 'doushi', masterName: '道志', prefCodes: ['14'] },
];

interface RawSeries {
  [hourIdx: string]: string;
  dt: string;
}

interface ApiResponse {
  lastUpdate: string;
  values: Record<string, RawSeries | Record<string, string>>;
}

interface ParsedRow {
  key: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function num(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse 「YYYY-MM-DD HH:MM」 as JST → UTC Date.
 * The kanagawa-dam.jp dt field is published in JST, not specified, but
 * empirically the API returns server-local time which is JST (= UTC+9).
 */
export function parseJstTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  // JST = UTC + 9, so subtract 9 hours from the JST clock to get UTC.
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 9, Number(mi)));
}

function latestField(series: RawSeries | undefined): { value: string | null; dt: string | null } {
  if (!series) return { value: null, dt: null };
  const dt = series.dt ?? null;
  // Index 29 is the most recent value in the 30-hour rolling window.
  const value = series['29'] ?? null;
  return { value, dt };
}

export function parseKanagawaResponse(body: ApiResponse): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const m of NAME_MAP) {
    const vol = latestField(body.values[`${m.key}_volume`] as RawSeries | undefined);
    const rate = latestField(body.values[`${m.key}_storage_level`] as RawSeries | undefined);
    const level = latestField(body.values[`${m.key}_water_level`] as RawSeries | undefined);
    const inflow = latestField(body.values[`${m.key}_in`] as RawSeries | undefined);
    const outflow = latestField(body.values[`${m.key}_out`] as RawSeries | undefined);
    // observedAt anchored to volume's dt (the headline metric); other
    // fields may be a few minutes ahead/behind but for hourly cadence
    // that's fine to lump together.
    const observedAt = vol.dt ? parseJstTimestamp(vol.dt) : null;
    if (!observedAt) continue;
    const volThouM3 = num(vol.value);
    const ratePct = num(rate.value);
    out.push({
      key: m.key,
      observedAt,
      // kanagawa volume is in 千m³ (thousand m³).
      storageVolumeM3: volThouM3 != null ? volThouM3 * 1_000 : null,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      waterLevelM: num(level.value),
      inflowM3s: num(inflow.value),
      outflowM3s: num(outflow.value),
    });
  }
  return out;
}

interface DamMatch {
  key: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('kanagawa-dam', 310,
            'かながわの水がめ (kanagawa-dam.jp) — hourly, 5 dams (相模/城山/三保/宮ヶ瀬/道志)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const m of NAME_MAP) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${m.masterName} THEN 0
          WHEN name = ${`${m.masterName}ダム`} THEN 1
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    // The API names its series by key (`sagami_volume`), so the key is the
    // provider's own identifier.
    universe.push({
      externalId: m.key,
      name: m.masterName,
      prefCode: m.prefCodes[0] ?? null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`kanagawa-dam: no master match for ${m.key} (${m.masterName})`);
      continue;
    }
    matches.push({ key: m.key, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('kanagawa-dam', ${m.key}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'kanagawa-dam', '') <> ${m.key}
    `;
  }
  await recordUniverse('kanagawa-dam', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`kanagawa-dam: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(API_URL, {
    headers: {
      accept: 'application/json',
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`kanagawa-dam: HTTP ${r.status}; aborting`);
    return;
  }
  const body = (await r.json()) as ApiResponse;
  const parsed = parseKanagawaResponse(body);
  log(`kanagawa-dam: parsed ${parsed.length} dam rows`);

  const matchByKey = new Map(matches.map((m) => [m.key, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByKey.get(row.key);
    if (!damId) continue;
    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: 'kanagawa-dam',
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`kanagawa-dam done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
