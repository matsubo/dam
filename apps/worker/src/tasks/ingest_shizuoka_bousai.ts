// apps/worker/src/tasks/ingest_shizuoka_bousai.ts
//
// 静岡県 SIPOS (静岡県土木総合防災情報システム) — JSON API, 6 dams, hourly.
//
// Source:
//   https://sipos.pref.shizuoka.jp/
// API:
//   Map/json/announced.json                        → {"dam":"YYYYMMDDHHmm", ...}
//   Map/json/Dam/YYYY/MM/DD/dam-YYYYMMDDHHmm.json → per-dam readings
//   etc/dam_master.json                            → {pointCode: {pointname, lat, lon, ...}}
// 6 dams:
//   2201200 奥野ダム,    2201201 太田川ダム,      2201202 都田川ダム（農）,
//   2201203 大倉川ダム（農）, 2201204 青野大師ダム, 8567001 長島ダム（国）
//
// Field scaling (from sipos.pref.shizuoka.jp/Dam/js/DamInfo.js):
//   lwtrlv          / 100  → EL m
//   data_storagerate / 1000 → fraction 0–1  (÷10=%, ÷100=ratio)
//   stwvol          * 1000 → m³  (unit is 千m³)
//   wflvol_in       / 100  → m³/s
//   wflvol_out      / 100  → m³/s
// Sentinels: -1111111111 = no data, -999999999 = not available → null
//
// NOTE: parseBousaiWebTable / parseBousaiTimestamp / detectColumns remain
// as named exports because ingest_shizuoka_bousai.test.ts tests them.
// They are no longer used by this task (which now uses SIPOS JSON).
//
// Priority 308. Cron hourly at :55.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const ANNOUNCED_URL =
  process.env.SIPOS_ANNOUNCED_URL ?? 'https://sipos.pref.shizuoka.jp/Map/json/announced.json';
const DAM_MASTER_URL =
  process.env.SIPOS_MASTER_URL ?? 'https://sipos.pref.shizuoka.jp/etc/dam_master.json';
const DAM_DATA_BASE = process.env.SIPOS_DATA_BASE ?? 'https://sipos.pref.shizuoka.jp/Map/json/Dam';

const PREF_CODE = '22';
const SOURCE_ID = 'shizuoka-bousai';
const SIPOS_NO_DATA = -1111111111;
const SIPOS_NOT_AVAIL = -999999999;
const POINT_CODES = ['2201200', '2201201', '2201202', '2201203', '2201204', '8567001'] as const;

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

// --- legacy 防災Web exports (kept for ingest_shizuoka_bousai.test.ts) ---------

export interface ColumnMap {
  damName: number;
  timestamp: number;
  waterLevel: number;
  storageVolume: number;
  storageRate: number;
  inflow: number;
  outflow: number;
}

export interface ParsedRow {
  damName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr|amp);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const clean = s.replace(/---+/g, '').trim();
  if (clean === '' || clean === '---') return null;
  const m = clean.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function parseBousaiTimestamp(s: string): Date | null {
  const clean = s.replace(/&nbsp;/g, ' ').trim();
  const m = clean.match(/(\d{4})[/ ](\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function detectColumns(headers: string[]): ColumnMap {
  const cols: ColumnMap = {
    damName: -1,
    timestamp: -1,
    waterLevel: -1,
    storageVolume: -1,
    storageRate: -1,
    inflow: -1,
    outflow: -1,
  };
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i] ?? '';
    if (cols.damName < 0 && /局名|ダム名|地点名/.test(h)) cols.damName = i;
    if (cols.timestamp < 0 && /観測時刻/.test(h)) cols.timestamp = i;
    if (cols.waterLevel < 0 && /貯水位/.test(h)) cols.waterLevel = i;
    if (cols.storageVolume < 0 && /貯水量/.test(h) && !/貯水率/.test(h)) cols.storageVolume = i;
    if (cols.storageRate < 0 && /貯水率/.test(h)) cols.storageRate = i;
    if (cols.inflow < 0 && /流入量/.test(h)) cols.inflow = i;
    if (cols.outflow < 0 && /放流量/.test(h)) cols.outflow = i;
  }
  return cols;
}

export function parseBousaiWebTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableMatches = Array.from(html.matchAll(/<table[\s\S]*?<\/table>/gi));
  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[0] ?? '';
    const trList = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
      Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(
        (c) => c[1] ?? '',
      ),
    );
    if (trList.length < 2) continue;
    let cols: ColumnMap | null = null;
    let dataStart = 0;
    for (let i = 0; i < Math.min(3, trList.length); i++) {
      const candidate = detectColumns((trList[i] ?? []).map(cleanCell));
      if (candidate.damName >= 0 && candidate.timestamp >= 0) {
        cols = candidate;
        dataStart = i + 1;
        break;
      }
    }
    if (!cols) continue;
    for (let i = dataStart; i < trList.length; i++) {
      const cells = trList[i] ?? [];
      if (cells.length < 5) continue;
      const rawName = cleanCell(cells[cols.damName] ?? '');
      if (!rawName) continue;
      const nameMatch = (cells[cols.damName] ?? '').match(/<a[^>]+>([^<]+)<\/a>/);
      const damName = nameMatch ? (nameMatch[1] ?? '').trim() : rawName;
      if (!damName.includes('ダム') && !damName.includes('貯水池')) continue;
      const tsRaw = cleanCell(cells[cols.timestamp] ?? '');
      const observedAt = parseBousaiTimestamp(tsRaw);
      const waterLevelM =
        cols.waterLevel >= 0 ? parseNum(cleanCell(cells[cols.waterLevel] ?? '')) : null;
      const rawVol =
        cols.storageVolume >= 0 ? parseNum(cleanCell(cells[cols.storageVolume] ?? '')) : null;
      const storageVolumeM3 = rawVol !== null ? rawVol * 1_000 : null;
      const storageRate =
        cols.storageRate >= 0 ? parseNum(cleanCell(cells[cols.storageRate] ?? '')) : null;
      const inflowM3s = cols.inflow >= 0 ? parseNum(cleanCell(cells[cols.inflow] ?? '')) : null;
      const outflowM3s = cols.outflow >= 0 ? parseNum(cleanCell(cells[cols.outflow] ?? '')) : null;
      if (
        observedAt === null &&
        waterLevelM === null &&
        storageVolumeM3 === null &&
        storageRate === null
      )
        continue;
      rows.push({
        damName,
        observedAt,
        waterLevelM,
        storageVolumeM3,
        storageRate,
        inflowM3s,
        outflowM3s,
      });
    }
    if (rows.length > 0) break;
  }
  return rows;
}

// --- SIPOS types and parsing --------------------------------------------------

export interface SiposReading {
  pointCode: string;
  pointName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function siposField(d: Record<string, unknown>, key: string): number {
  const v = d[key];
  return typeof v === 'number' ? v : SIPOS_NO_DATA;
}

function siposScale(value: number, scale: number): number | null {
  if (value === SIPOS_NO_DATA || value === SIPOS_NOT_AVAIL) return null;
  const result = value * scale;
  return Number.isFinite(result) ? result : null;
}

/** Parse "YYYYMMDDHHmm" JST string → UTC Date. */
export function parseSiposTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mo, dy, hr, mi] = m;
  const d = new Date(Date.UTC(+(yy ?? 0), +(mo ?? 0) - 1, +(dy ?? 0), +(hr ?? 0) - 9, +(mi ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract readings from a SIPOS dam JSON blob for the 6 known point codes. */
export function parseSiposJson(
  data: Record<string, unknown>,
  masterNames: Record<string, string>,
  timestamp: string,
): SiposReading[] {
  const observedAt = parseSiposTimestamp(timestamp);
  const readings: SiposReading[] = [];

  for (const code of POINT_CODES) {
    const entry = data[code] as { dam?: Record<string, unknown>[] } | undefined;
    const d = entry?.dam?.[0];
    if (!d) continue;

    readings.push({
      pointCode: code,
      pointName: masterNames[code] ?? code,
      observedAt,
      waterLevelM: siposScale(siposField(d, 'lwtrlv'), 0.01),
      storageVolumeM3: siposScale(siposField(d, 'stwvol'), 1000),
      storageRate: siposScale(siposField(d, 'data_storagerate'), 0.001),
      inflowM3s: siposScale(siposField(d, 'wflvol_in'), 0.01),
      outflowM3s: siposScale(siposField(d, 'wflvol_out'), 0.01),
    });
  }

  return readings;
}

// --- DB helpers ---------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '静岡県 SIPOS ダム情報 JSON API — 6 dams (奥野/太田川/都田川農/大倉川農/青野大師/長島国), hourly',
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

interface DamMatch {
  pointCode: string;
  damId: bigint;
}

async function matchMaster(
  readings: SiposReading[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<
    { id: bigint; name: string; external_ids: Record<string, string> | null }[]
  >`
    SELECT id, name, external_ids FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of readings) {
    // Prefer external_id lookup first (stable once set)
    const byExtId = masters.find((m) => m.external_ids?.[SOURCE_ID] === r.pointCode);
    if (byExtId) {
      out.push({ pointCode: r.pointCode, damId: byExtId.id });
      continue;
    }

    // Fall back to name matching
    const stem = normalizeName(r.pointName);
    if (!stem) continue;
    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.pointName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }
    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.pointName}" (${r.pointCode})`);
      continue;
    }

    // Persist external_id for future runs
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.pointCode}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.pointCode}
    `;
    out.push({ pointCode: r.pointCode, damId: best.id });
  }

  return out;
}

// --- task ---------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const headers = { 'user-agent': USER_AGENT };
  const signal = AbortSignal.timeout(20_000);

  // 1. Fetch current announced timestamp
  const announcedResp = await fetch(ANNOUNCED_URL, { headers, signal });
  if (announcedResp.status !== 200) {
    log(`${SOURCE_ID}: announced.json HTTP ${announcedResp.status}; aborting`);
    return;
  }
  const announced = (await announcedResp.json()) as Record<string, string>;
  const timestamp = announced.dam;
  if (!timestamp || !/^\d{12}$/.test(timestamp)) {
    log(`${SOURCE_ID}: unexpected announced.dam=${JSON.stringify(timestamp)}; aborting`);
    return;
  }

  // 2. Fetch dam data JSON
  const yy = timestamp.slice(0, 4);
  const mm = timestamp.slice(4, 6);
  const dd = timestamp.slice(6, 8);
  const dataUrl = `${DAM_DATA_BASE}/${yy}/${mm}/${dd}/dam-${timestamp}.json`;
  const dataResp = await fetch(dataUrl, { headers, signal: AbortSignal.timeout(20_000) });
  if (dataResp.status !== 200) {
    log(`${SOURCE_ID}: dam JSON HTTP ${dataResp.status} for ${timestamp}; aborting`);
    return;
  }
  const data = (await dataResp.json()) as Record<string, unknown>;

  // 3. Fetch dam master names
  const masterResp = await fetch(DAM_MASTER_URL, { headers, signal: AbortSignal.timeout(20_000) });
  const masterNames: Record<string, string> = {};
  if (masterResp.status === 200) {
    const masterData = (await masterResp.json()) as Record<string, { pointname?: string }>;
    for (const [code, info] of Object.entries(masterData)) {
      if (info.pointname) masterNames[code] = info.pointname;
    }
  }

  // 4. Parse readings
  const readings = parseSiposJson(data, masterNames, timestamp);
  log(`${SOURCE_ID}: parsed ${readings.length} readings at ${timestamp}`);

  // 5. Match to master DB
  const matches = await matchMaster(readings, log);
  const damByCode = new Map(matches.map((m) => [m.pointCode, m.damId]));

  // 6. Build upsert inputs
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const r of readings) {
    const damId = damByCode.get(r.pointCode);
    if (!damId) continue;
    if (!r.observedAt) {
      log(`${SOURCE_ID}: missing observedAt for ${r.pointCode}; skipping`);
      continue;
    }
    if (r.waterLevelM === null && r.storageVolumeM3 === null && r.storageRate === null) continue;

    inputs.push({
      observedAt: r.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: r.storageRate,
      inflowM3s: r.inflowM3s,
      outflowM3s: r.outflowM3s,
      waterLevelM: r.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${readings.length} matched=${matches.length} written=${written}`);
};

export default task;
