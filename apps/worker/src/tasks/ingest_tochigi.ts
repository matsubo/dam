// apps/worker/src/tasks/ingest_tochigi.ts
//
// Phase B6 (#10, BODIK batch): 栃木県 ダム諸量 — official BODIK open-data
// CSV in NGSI-v2 shape. CC-BY 4.0, refreshed every 10 minutes.
//
// Source: data.bodik.jp dataset 090000_river_dam_parameter, resource
// `tochigi_dampref.csv`. Columns (RFC-4180 quoted, the `location` field
// embeds a JSON object with "" escapes):
//
//   id,type,address,dateObserved,inflow,location,officeName,officeNumber,
//   outflow,pointName,pointNumber,riverName,riverSystemName,
//   waterLevel,waterStorage
//
// dateObserved is already an ISO-8601 UTC timestamp. waterStorage is in
// 千m³ — multiply by 1000 for m³. Seven prefectural dams in this feed
// (寺山/塩原/西荒川/東荒川/三河沢/中禅寺/松田川). Cron hourly at :27.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const CSV_URL =
  process.env.TOCHIGI_DAM_CSV ??
  'https://data.bodik.jp/dataset/a66bea6a-bb25-404f-a16d-dc839c75e007/resource/2e94dd9c-7157-498b-88c7-cbc0c85c6297/download/tochigi_dampref.csv';
const PREF_CODE = '09';
const SOURCE_ID = 'tochigi-bodik';

export interface ParsedRow {
  tochigiName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/**
 * Minimal RFC-4180 CSV-line splitter: handles double-quoted fields with
 * embedded commas and the `""` escape for a literal `"`. Newlines are
 * assumed to delimit records (the feed never embeds them inside fields).
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let cur = '';
  let inQuote = false;
  while (i < line.length) {
    const c = line[i] ?? '';
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuote = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      out.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  out.push(cur);
  return out;
}

function parseNum(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the NGSI-v2 dam CSV. Skips the header and any row that lacks a
 * parseable observation time or dam name.
 */
export function parseTochigiCsv(csv: string): ParsedRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: ParsedRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = splitCsvLine(line);
    if (c.length < 15) continue;
    if (c[0] === 'id') continue; // header
    const name = (c[9] ?? '').trim();
    const stampStr = (c[3] ?? '').trim();
    if (!name || !stampStr) continue;
    const observedAt = new Date(stampStr);
    if (Number.isNaN(observedAt.valueOf())) continue;
    const volThou = parseNum(c[14] ?? '');
    out.push({
      tochigiName: name,
      observedAt,
      waterLevelM: parseNum(c[13] ?? ''),
      storageVolumeM3: volThou != null ? volThou * 1_000 : null,
      inflowM3s: parseNum(c[4] ?? ''),
      outflowM3s: parseNum(c[8] ?? ''),
    });
  }
  return out;
}

/** Strip ダム + （...）annotations for master matching. */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** Best master dam for a feed stem; exact stem match beats substring. */
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

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 311,
            '栃木県河川水位・雨量情報システム — BODIK ダム諸量 NGSI-v2 CSV (CC-BY 4.0, 10分更新, 7観測所)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  tochigiName: string;
  damId: bigint;
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
    const stem = normalizeName(r.tochigiName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
    universe.push({
      externalId: r.tochigiName,
      name: r.tochigiName,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.tochigiName}`);
      continue;
    }
    out.push({ tochigiName: r.tochigiName, damId });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.tochigiName}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.tochigiName}
    `;
  }
  await recordUniverse(SOURCE_ID, universe);
  return out;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const res = await fetch(CSV_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const csv = await res.text();
  const parsed = parseTochigiCsv(csv);
  log(`${SOURCE_ID}: parsed ${parsed.length} dam rows`);

  const matches = await matchMaster(parsed, log);
  const damByName = new Map(matches.map((m) => [m.tochigiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByName.get(p.tochigiName);
    if (!damId) continue;
    if (
      p.waterLevelM == null &&
      p.storageVolumeM3 == null &&
      p.inflowM3s == null &&
      p.outflowM3s == null
    ) {
      continue;
    }
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: null,
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
