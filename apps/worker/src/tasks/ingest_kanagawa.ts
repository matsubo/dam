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
//     "lastUpdate": "2026-09-27",
//     "values": {
//       "sagami_volume": {"0":"34509", ..., "29":"34615", "dt":"2026-09-27 03:00"},
//       "sagami_storage_level": {...},          // 貯水率 %
//       "sagami_water_level": {...},            // 貯水位 EL.m
//       "sagami_in": {...},                     // 流入量 m³/s
//       "sagami_out": {...},                    // 放流量 m³/s
//       ... same shape for shiroyama / miho / miyagase / doushi
//     }
//   }
//
// Each series is a 30-DAY daily window: index 29 is the `lastUpdate` day,
// index 0 is 29 days earlier. Checked against the hourly /api/weekly.php
// table: volume / storage_level / water_level are the day's 24:00 JST reading,
// in / out are the day's hourly mean. lastUpdate rolls over at ~01:00 JST.
// The per-series `dt` is NOT a reading time — it steps back one hour per key
// in response order — so it is ignored; every day is stamped at 24:00 JST.
//
// All 5 dams are NEW — none were covered by tokyo-waterworks / jwa-junpo /
// aitoyo / jwa-chikugo. They're high-profile dams supplying the Kanagawa
// prefecture water system (~9 million people).
//
// The whole window is upserted each run, so a missed poll heals itself.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
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

/** Day index → value; also carries the meaningless `dt`, never read. */
type RawSeries = Record<string, string>;

interface ApiResponse {
  lastUpdate: string;
  values: Record<string, RawSeries>;
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

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function num(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `lastUpdate` 「YYYY-MM-DD」 → that day's 24:00 JST (= 15:00Z the same date). */
export function parseKanagawaLastUpdate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15));
}

export function parseKanagawaResponse(body: ApiResponse): ParsedRow[] {
  const newest = parseKanagawaLastUpdate(body.lastUpdate);
  if (!newest) return [];
  const out: ParsedRow[] = [];
  for (const m of NAME_MAP) {
    const vol = body.values[`${m.key}_volume`];
    const rate = body.values[`${m.key}_storage_level`];
    const level = body.values[`${m.key}_water_level`];
    const inflow = body.values[`${m.key}_in`];
    const outflow = body.values[`${m.key}_out`];
    for (let i = 0; i < WINDOW_DAYS; i++) {
      const idx = String(i);
      const volThouM3 = num(vol?.[idx]);
      const ratePct = num(rate?.[idx]);
      const row: ParsedRow = {
        key: m.key,
        observedAt: new Date(newest.getTime() - (WINDOW_DAYS - 1 - i) * DAY_MS),
        // kanagawa volume is in 千m³ (thousand m³).
        storageVolumeM3: volThouM3 != null ? volThouM3 * 1_000 : null,
        storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
        waterLevelM: num(level?.[idx]),
        inflowM3s: num(inflow?.[idx]),
        outflowM3s: num(outflow?.[idx]),
      };
      if (
        row.storageVolumeM3 == null &&
        row.storageRate == null &&
        row.waterLevelM == null &&
        row.inflowM3s == null &&
        row.outflowM3s == null
      ) {
        continue;
      }
      out.push(row);
    }
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
            'かながわの水がめ (kanagawa-dam.jp) — daily 24時値, 5 dams (相模/城山/三保/宮ヶ瀬/道志)',
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
    // A redeveloped dam's twins share the ELSE rank, so chooseRanked picks the
    // current one; a row already stamped with the key keeps it (#79).
    const rows = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>'kanagawa-dam' AS stamp,
             CASE
               WHEN name = ${m.masterName} THEN 0
               WHEN name = ${`${m.masterName}ダム`} THEN 1
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
      ORDER BY rank, id
    `;
    const r = chooseRanked(rows, m.key);
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
    await bindExternalId(r.id, 'kanagawa-dam', m.key);
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
