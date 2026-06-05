// apps/worker/src/tasks/backfill_kagoshima_bodik.ts
//
// Historical backfill from 鹿児島県 BODIK open-data ZIP archives.
//
//   3 dams: 大和ダム / 川辺ダム / 西之谷ダム — 10-minute intervals, 2008–present.
//   License: CC BY (data.bodik.jp/dataset/1b0c5baf-e309-4ad3-8c31-a4dc3cc9781f)
//
// Each ZIP contains one Shift_JIS CSV per dam per month:
//   YYYYMM_ダム諸量_{ダム名}.csv
//
// CSV unit conversions (headers in row 3):
//   観測時刻  "YYYY/M/D H:MM" JST (no leading zeros)
//   貯水位    [EL.10^2m]      raw / 100 = EL.m
//   全流入量  [10^-3m3/s]     raw / 1000 = m³/s
//   全放流量  [10^-3m3/s]     raw / 1000 = m³/s
//   貯水量    [10^3m3]        raw * 1000 = m³ (千m³)
//   空容量    [10^3m3]        raw * 1000 = m³ (not stored)
//   貯水率    [10^-1%]        raw / 10 = %
//
// Priority: 296 — historical data, below real-time sources.
//
// Triggered ad-hoc; no cron.  To re-import new months:
//   add_job('backfill:kagoshima-bodik', {})
// To import only recent years:
//   add_job('backfill:kagoshima-bodik', { fromYear: 2024 })

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { unzipSync } from 'fflate';
import type { Task } from 'graphile-worker';

const BODIK_PACKAGE_ID = '1b0c5baf-e309-4ad3-8c31-a4dc3cc9781f';
const BODIK_API_BASE = process.env.BODIK_API_BASE ?? 'https://data.bodik.jp';

const PREF_CODE = '46';
const SOURCE_ID = 'kagoshima-bodik';

const HEADERS = {
  'user-agent':
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
};

// --- types ------------------------------------------------------------------

interface BackfillPayload {
  /** Import only ZIPs whose year >= fromYear. Default: import all (2008+). */
  fromYear?: number;
}

export interface ParsedRow {
  damName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/M/D H:MM" or "YYYY/M/D HH:MM" JST → UTC */
export function parseKagoshimaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseIntOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a single Kagoshima ダム諸量 CSV (Shift_JIS bytes decoded to string).
 * Returns all valid data rows; dam name extracted from the first row.
 */
export function parseKagoshimaCsv(text: string): ParsedRow[] {
  const lines = text.split('\n');
  if (lines.length < 5) return [];

  // Row 0: dam name (first CSV field)
  const damName = (lines[0] ?? '').split(',')[0]?.trim() ?? '';
  if (!damName) return [];

  const rows: ParsedRow[] = [];

  // Data starts at row 4 (0-indexed)
  for (let i = 4; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 5) continue;

    const ts = cols[0]?.trim() ?? '';
    const observedAt = parseKagoshimaTimestamp(ts);
    if (!observedAt) continue;

    const rawLevel = parseIntOrNull(cols[1] ?? '');
    const rawInflow = parseIntOrNull(cols[2] ?? '');
    const rawOutflow = parseIntOrNull(cols[3] ?? '');
    const rawStorage = parseIntOrNull(cols[4] ?? '');
    // cols[5] = 空容量 (not stored)
    // cols[6] = 貯水率（治水）, cols[7] = 貯水率（利水）
    const rawRateTreatment = parseIntOrNull(cols[6] ?? '');
    const rawRateUsage = parseIntOrNull(cols[7] ?? '');

    rows.push({
      damName,
      observedAt,
      waterLevelM: rawLevel !== null ? rawLevel / 100 : null,
      storageVolumeM3: rawStorage !== null ? rawStorage * 1_000 : null,
      // Prefer 治水貯水率 if available, else 利水貯水率
      storageRate:
        rawRateTreatment !== null
          ? rawRateTreatment / 10
          : rawRateUsage !== null
            ? rawRateUsage / 10
            : null,
      inflowM3s: rawInflow !== null ? rawInflow / 1_000 : null,
      outflowM3s: rawOutflow !== null ? rawOutflow / 1_000 : null,
    });
  }

  return rows;
}

/** Extract the year from a BODIK resource name like "ダム諸量情報（2024年1月〜12月）" */
export function extractYearFromResourceName(name: string): number | null {
  const m = name.match(/（(\d{4})年/);
  if (!m) return null;
  const yr = Number(m[1]);
  return Number.isFinite(yr) ? yr : null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 296,
            '鹿児島県 BODIK ダム諸量 — 3 dams (大和/川辺/西之谷), 10-min, 2008+, CC-BY',
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

async function resolveDamIds(
  names: string[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out = new Map<string, bigint>();

  for (const rawName of names) {
    const stem = normalizeName(rawName);
    if (!stem) continue;

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

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${rawName}"`);
      continue;
    }

    out.set(rawName, best.id);
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${rawName}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${rawName}
    `;
  }

  return out;
}

// --- fetch helpers ----------------------------------------------------------

interface BodikResource {
  name: string;
  url: string;
}

async function fetchResourceList(): Promise<BodikResource[]> {
  const url = `${BODIK_API_BASE}/api/3/action/package_show?id=${BODIK_PACKAGE_ID}`;
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
  if (r.status !== 200) throw new Error(`BODIK package API: HTTP ${r.status}`);
  const data = (await r.json()) as { result: { resources: BodikResource[] } };
  return data.result.resources.filter((res) => res.url.endsWith('.zip'));
}

async function downloadZip(url: string): Promise<Uint8Array> {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
  if (r.status !== 200) throw new Error(`ZIP download: HTTP ${r.status} ${url}`);
  const buf = await r.arrayBuffer();
  return new Uint8Array(buf);
}

// --- task -------------------------------------------------------------------

const BATCH_SIZE = 1_000;

const task: Task = async (payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const { fromYear } = (payload ?? {}) as BackfillPayload;

  await ensureSourcePriority();

  const resources = await fetchResourceList();
  log(`${SOURCE_ID}: found ${resources.length} ZIP resources`);

  let totalWritten = 0;

  for (const res of resources) {
    const year = extractYearFromResourceName(res.name);
    if (year === null) {
      log(`${SOURCE_ID}: cannot parse year from "${res.name}"; skipping`);
      continue;
    }
    if (fromYear !== undefined && year < fromYear) continue;

    log(`${SOURCE_ID}: downloading ${res.name}`);
    let zipBytes: Uint8Array;
    try {
      zipBytes = await downloadZip(res.url);
    } catch (err) {
      log(`${SOURCE_ID}: failed to download "${res.name}": ${err}`);
      continue;
    }

    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(zipBytes);
    } catch (err) {
      log(`${SOURCE_ID}: failed to unzip "${res.name}": ${err}`);
      continue;
    }

    const csvFiles = Object.keys(entries).filter((f) => f.endsWith('.csv'));
    log(`${SOURCE_ID}: ${res.name} — ${csvFiles.length} CSV files`);

    // Resolve dam IDs from all dam names in this ZIP
    const allDamNames = new Set<string>();
    const allRows: ParsedRow[] = [];

    for (const csvPath of csvFiles) {
      const bytes = entries[csvPath];
      if (!bytes) continue;
      const text = new TextDecoder('shift-jis').decode(bytes);
      const rows = parseKagoshimaCsv(text);
      for (const r of rows) allDamNames.add(r.damName);
      allRows.push(...rows);
    }

    if (allRows.length === 0) {
      log(`${SOURCE_ID}: no rows parsed from ${res.name}`);
      continue;
    }

    const damIdByName = await resolveDamIds([...allDamNames], log);

    // Upsert in batches
    const inputs = [] as Parameters<typeof upsertObservations>[0];
    for (const p of allRows) {
      const damId = damIdByName.get(p.damName);
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

    for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
      const batch = inputs.slice(i, i + BATCH_SIZE);
      const written = await upsertObservations(batch);
      totalWritten += written;
    }

    log(`${SOURCE_ID}: ${res.name} — parsed=${allRows.length} written≈${inputs.length}`);
  }

  log(`${SOURCE_ID} backfill done: total written≈${totalWritten}`);
};

export default task;
