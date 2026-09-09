// apps/worker/src/tasks/ingest_shimokubo.ts
//
// 水資源機構 利根川上流総合管理所 下久保ダム — real-time data every 10 minutes.
// Fetched hourly.
//
//   下久保ダム (群馬/埼玉) — JWA-managed; utilization capacity 12,000 万m³
//
// Source: http://shimokubo.kannet.ne.jp/data/table.json
// Format: JSON with UTF-8-BOM; `update_time` in JST; `records[].datas[-1].data10`
//         holds the latest 10-min reading.  Storage in 千m³ → stored as m³ (×1000).
//
// Upgrades jwa-toneara (daily, priority 296) → hourly for 下久保ダム.
// Priority 297 > 296.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.SHIMOKUBO_DATA_URL ?? 'http://shimokubo.kannet.ne.jp/data/table.json';

const SOURCE_ID = 'shimokubo';
/** The only dam this feed publishes; it carries no station id. */
const DAM_NAME = '下久保ダム';
/** 下久保 straddles 群馬/埼玉; ダム便覧 files it under 群馬. */
const PREF_CODE = '10';

// --- types ------------------------------------------------------------------

interface Record10 {
  data10: string;
  data60: string;
}

interface DamRecord {
  name: string;
  datas: Record10[];
}

interface ShimokuboJson {
  update_time: string;
  times: Array<{ time60: string; time10: string }>;
  records: DamRecord[];
}

export interface ParsedReading {
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseShimokuboTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [yr, mo, dy, hr, mi] = m.slice(1, 6).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function latestData10(records: DamRecord[], name: string): string | null {
  const rec = records.find((r) => r.name === name);
  if (!rec || rec.datas.length === 0) return null;
  return rec.datas[rec.datas.length - 1]?.data10 ?? null;
}

export function parseShimokuboJson(json: ShimokuboJson): ParsedReading {
  const observedAt = parseShimokuboTimestamp(json.update_time);

  const waterLevelM = parseNum(latestData10(json.records, '下久保ダム貯水位') ?? '');
  const storageThou = parseNum(latestData10(json.records, '下久保ダム有効容量内貯水量') ?? '');
  const rateRaw = parseNum(latestData10(json.records, '下久保ダム有効容量内貯水率') ?? '');
  const inflowM3s = parseNum(latestData10(json.records, '下久保ダム全流入量') ?? '');
  const outflowM3s = parseNum(latestData10(json.records, '下久保ダム全放流量') ?? '');

  return {
    observedAt,
    waterLevelM,
    storageVolumeM3: storageThou !== null ? storageThou * 1_000 : null,
    storageRate: rateRaw !== null ? rateRaw / 100 : null,
    inflowM3s,
    outflowM3s,
  };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 297,
            '水資源機構 利根川上流総合管理所 下久保ダム 実時計 (10分間隔)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function resolveDamId(log: (s: string) => void): Promise<bigint | null> {
  const rows = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams
    WHERE pref_code = ANY(ARRAY['10', '11'])
      AND name LIKE '%下久保%'
    ORDER BY
      CASE
        WHEN name = '下久保ダム' THEN 0
        WHEN name = '下久保'     THEN 1
        ELSE 2
      END,
      id
    LIMIT 1
  `;
  if (!rows[0]) {
    log(`${SOURCE_ID}: no master match for 下久保ダム`);
    return null;
  }
  const { id, name } = rows[0];
  await sql`
    UPDATE dams
    SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                     || jsonb_build_object(${SOURCE_ID}::text, '下久保ダム'::text)
    WHERE id = ${id}
      AND COALESCE(external_ids->>${SOURCE_ID}, '') <> '下久保ダム'
  `;
  log(`${SOURCE_ID}: matched "${name}" (id=${id})`);
  return id;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const damId = await resolveDamId(log);
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  await recordUniverse(SOURCE_ID, [
    { externalId: DAM_NAME, name: DAM_NAME, prefCode: PREF_CODE, resolvedDamId: damId },
  ]);
  if (!damId) return;

  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  // The file uses a UTF-8 BOM; strip it before parsing.
  const raw = await r.arrayBuffer();
  const text = new TextDecoder('utf-8').decode(raw).replace(/^﻿/, '');
  const json = JSON.parse(text) as ShimokuboJson;

  const reading = parseShimokuboJson(json);
  log(
    `${SOURCE_ID}: observedAt=${reading.observedAt?.toISOString() ?? '(missing)'} ` +
      `waterLevel=${reading.waterLevelM} storageM3=${reading.storageVolumeM3} ` +
      `inflow=${reading.inflowM3s} outflow=${reading.outflowM3s}`,
  );

  if (!reading.observedAt) {
    log(`${SOURCE_ID}: no timestamp; aborting`);
    return;
  }
  if (reading.waterLevelM === null && reading.storageVolumeM3 === null) {
    log(`${SOURCE_ID}: all primary metrics null; skipping`);
    return;
  }

  const written = await upsertObservations([
    {
      observedAt: reading.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: reading.storageVolumeM3,
      storageRate: reading.storageRate,
      inflowM3s: reading.inflowM3s,
      outflowM3s: reading.outflowM3s,
      waterLevelM: reading.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(`${SOURCE_ID} done: written=${written}`);
};

export default task;
