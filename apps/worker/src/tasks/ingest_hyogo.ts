// apps/worker/src/tasks/ingest_hyogo.ts
//
// Phase B4 (#8): 兵庫県 ダム諸量 — official BODIK open-data CSV.
//
// Source: data.bodik.jp dataset 280003_dam_hyogo, a single CSV refreshed
// every 10 minutes under a CC-BY 4.0 licence — the cleanest kind of source.
//
//   局番号,観測所名,観測時刻,貯水位[m],貯水位フラグ,貯水量[1000m3],貯水量フラグ,
//   全流入量[m3/s],全流入量フラグ,全放流量[m3/s],全放流量フラグ
//
// A value is valid only when its companion flag is "0" (160 = missing).
// 貯水量 is in 千m³ → ×1000 for m³. 22 stations (incl. a 分水堰 weir that
// won't match the dam master and is simply skipped). Cron hourly at :25.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const CSV_URL =
  process.env.HYOGO_DAM_CSV ??
  'https://data.bodik.jp/dataset/d854dd8e-0bf8-4821-8bc2-88108c32156f/resource/eaabaacb-97fb-451a-b0b8-10e2ece3f90c/download/tm-dam.csv';
const PREF_CODE = '28';
const SOURCE_ID = 'hyogo-bodik';

export interface ParsedRow {
  hyogoName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/** Parse 「YYYY/MM/DD HH:MM」 (JST) → UTC Date. */
function parseStamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** A value is trustworthy only when its companion flag is "0". */
function gated(value: string, flag: string): number | null {
  if (flag.trim() !== '0') return null;
  const t = value.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the BODIK dam CSV. Skips the header and any row that lacks a
 * parseable observation time.
 */
export function parseHyogoCsv(csv: string): ParsedRow[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/);
  const out: ParsedRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = line.split(',');
    if (c.length < 11) continue;
    if (c[0]?.trim() === '局番号') continue; // header
    const name = (c[1] ?? '').trim();
    const observedAt = parseStamp(c[2] ?? '');
    if (!name || !observedAt) continue;
    const volThou = gated(c[5] ?? '', c[6] ?? '');
    out.push({
      hyogoName: name,
      observedAt,
      waterLevelM: gated(c[3] ?? '', c[4] ?? ''),
      storageVolumeM3: volThou != null ? volThou * 1_000 : null,
      inflowM3s: gated(c[7] ?? '', c[8] ?? ''),
      outflowM3s: gated(c[9] ?? '', c[10] ?? ''),
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
            '兵庫県 ダム諸量 BODIK オープンデータ (CC-BY 4.0, 10分更新, 22観測所)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  hyogoName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  for (const r of rows) {
    const stem = normalizeName(r.hyogoName);
    if (!stem) continue;
    const damId = chooseMaster(stem, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for ${r.hyogoName}`);
      continue;
    }
    out.push({ hyogoName: r.hyogoName, damId });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.hyogoName}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.hyogoName}
    `;
  }
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
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const csv = await res.text();
  const parsed = parseHyogoCsv(csv);
  log(`${SOURCE_ID}: parsed ${parsed.length} dam rows`);

  const matches = await matchMaster(parsed, log);
  const damByName = new Map(matches.map((m) => [m.hyogoName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of parsed) {
    const damId = damByName.get(p.hyogoName);
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
