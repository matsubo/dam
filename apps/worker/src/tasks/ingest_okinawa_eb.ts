// apps/worker/src/tasks/ingest_okinawa_eb.ts
//
// 沖縄県企業局 — 2 個別ダム 日次.
//
//   倉敷ダム (沖縄 47, 県管理) / 山城ダム (沖縄 47, 企業局管理)
//
// Source:
//   https://www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv
// Format: UTF-8 CSV, 5 rows x 5 columns. Updated daily at midnight JST.
//   Row 0: date (MM月DD日), national_vol, kurasiki_vol, yamashiro_vol, total_vol
//   Row 1: (same date), national_max, kurasiki_max, yamashiro_max, total_max
//   Row 2: (same date), national_rate, kurasiki_rate, yamashiro_rate, total_rate
//   Row 3: (same date), national_avg, kurasiki_avg, yamashiro_avg, total_avg
//   Row 4: (same date), national_diff, kurasiki_diff, yamashiro_diff, total_diff
//   All volume values are in 千m³ (1000 m³).
// Coverage:
//   倉敷ダム (col 2): 県管理 — 5,900千m³ total capacity
//   山城ダム (col 3): 企業局管理 — 1,190千m³ total capacity
//   国管理ダム (col 1): aggregate for 9 national dams; NOT stored here
//     (those 9 dams are covered by kasenbosai_v2 via kawabou)
// Priority: 302 (pref/bureau-managed water supply, daily).
// Cron: daily at 03:00 UTC = 12:00 JST.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const CSV_URL =
  process.env.OKINAWA_EB_CSV_URL ?? 'https://www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv';

const PREF_CODE = '47';
const SOURCE_ID = 'okinawa-eb';

const DAMS: ReadonlyArray<{ csvName: string; masterName: string; colIdx: number }> = [
  { csvName: '倉敷ダム', masterName: '倉敷', colIdx: 2 },
  { csvName: '山城ダム', masterName: '山城', colIdx: 3 },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  csvName: string;
  observedAt: Date;
  storageVolumeM3: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse "MM月DD日" with no year, returning a Date at midnight JST.
 * Year is inferred: if the parsed month/day is more than 1 day ahead of
 * `now` (in JST), decrement the year by one (i.e. the data is from last year).
 */
export function parseOkinawaDate(dateStr: string, now: Date = new Date()): Date | null {
  const m = dateStr.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  if (Number.isNaN(mo) || Number.isNaN(dy)) return null;

  // Current JST date
  const nowJst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let year = nowJst.getUTCFullYear();

  // Try this year first; if >1 day in the future, fall back to last year
  let candidate = new Date(Date.UTC(year, mo - 1, dy, -9, 0, 0, 0));
  if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, mo - 1, dy, -9, 0, 0, 0));
  }
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

/** Parse the 5-row dam-youryou.csv into one row per individual dam. */
export function parseOkinawaEbCsv(csv: string, now: Date = new Date()): ParsedRow[] {
  const lines = csv
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 3) return [];

  // Row 0: date,national_vol,kurasiki_vol,yamashiro_vol,total_vol
  const volCols = lines[0]?.split(',') ?? [];
  // Row 2: date,national_rate,kurasiki_rate,yamashiro_rate,total_rate
  const rateCols = lines[2]?.split(',') ?? [];

  const observedAt = parseOkinawaDate(volCols[0]?.trim() ?? '', now);
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];
  for (const dam of DAMS) {
    const volRaw = volCols[dam.colIdx]?.trim();
    const rateRaw = rateCols[dam.colIdx]?.trim();

    const volThousandsM3 = volRaw !== undefined && volRaw !== '' ? Number(volRaw) : null;
    const rate = rateRaw !== undefined && rateRaw !== '' ? Number(rateRaw) : null;

    if (
      (volThousandsM3 === null || Number.isNaN(volThousandsM3)) &&
      (rate === null || Number.isNaN(rate))
    ) {
      continue;
    }

    rows.push({
      csvName: dam.csvName,
      observedAt,
      storageVolumeM3:
        volThousandsM3 !== null && !Number.isNaN(volThousandsM3) ? volThousandsM3 * 1000 : null,
      storageRate: rate !== null && !Number.isNaN(rate) ? rate : null,
    });
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 302,
            '沖縄県企業局 — 倉敷・山城ダム日次 (貯水量+貯水率)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(
  rows: ParsedRow[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The
  // published list is both CSV dam columns, not just the ones carrying a
  // value today; the CSV has no station ids, so the published name keyed by
  // prefecture is the stable identity.
  const universe: UniverseRow[] = [];
  const reported = new Set(rows.map((r) => r.csvName));

  for (const dam of DAMS) {
    const stem = dam.masterName;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      let rank: number;
      if (m.name === dam.csvName) rank = 0;
      else if (m.name === `${stem}ダム`) rank = 1;
      else if (m.name === stem) rank = 2;
      else if (m.name.startsWith(stem)) rank = 3;
      else if (m.name.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    universe.push({
      externalId: dam.csvName,
      name: dam.csvName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${dam.csvName}"`);
      continue;
    }
    if (reported.has(dam.csvName)) out.set(dam.csvName, best.id);
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const r = await fetch(CSV_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}`);
    return;
  }
  const csv = await r.text();

  const rows = parseOkinawaEbCsv(csv);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const damMap = await matchMaster(rows, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damMap.get(p.csvName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damMap.size} written=${written}`);
};

export default task;
