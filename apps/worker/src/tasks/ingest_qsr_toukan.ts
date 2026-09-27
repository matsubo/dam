// apps/worker/src/tasks/ingest_qsr_toukan.ts
//
// 国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 国管理ダム (筑後川水系).
//
//   松原ダム / 下筌ダム (both in Oita/44)
//
// Source:
//   https://www.qsr.mlit.go.jp/toukan/bousaijouhou.php
//   UTF-8 HTML; two tables, each with one data row (latest reading).
//   Updated on the hour (毎時00分更新).
//
// Table structure (2 header rows + 1 data row per dam):
//   [0] 観測時刻  "YYYY/MM/DD HH:MM" (JST)
//   [1] 貯水位[m]
//   [2] 流入量[m3/s]
//   [3] ゲート放流量[m3/s]
//   [4] 発電使用水量[m3/s]
//   [5] 全放流量[m3/s]   ← preferred outflow
//   [6] 時間雨量[mm]
//   [7] 累加雨量[mm]
//   [8] 流域時間雨量[mm]
//   [9] 流域累加雨量[mm]
//
// Priority 303 (MLIT-managed dams). Cron hourly at :26.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.QSR_TOUKAN_URL ?? 'https://www.qsr.mlit.go.jp/toukan/bousaijouhou.php';

const SOURCE_ID = 'qsr-toukan-dam';

// --- dam config -------------------------------------------------------------

interface DamCfg {
  pageName: string;
  masterName: string;
  prefCode: string;
}

// Table index 0-based (among the two data tables, table[1] and table[2] in the page)
const DAMS: DamCfg[] = [
  { pageName: '松原ダム', masterName: '松原', prefCode: '44' },
  { pageName: '下筌ダム', masterName: '下筌', prefCode: '44' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

// --- parsing ----------------------------------------------------------------

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = (s ?? '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseToukantimestamp(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract the Nth data table from the HTML (1-indexed, skips the first decorative table). */
function extractTable(html: string, tableIdx: number): string[][] {
  const tableMatches = Array.from(html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi));
  const table = tableMatches[tableIdx];
  if (!table) return [];
  const rows: string[][] = [];
  for (const trMatch of (table[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((trMatch[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(
      (m) => stripTags(m[1] ?? ''),
    );
    rows.push(cells);
  }
  return rows;
}

/** Parse data from a two-header-row table: row[0]=header1, row[1]=header2, row[2]=data. */
export function parseToukantable(html: string, tableIdx: number): ParsedRow | null {
  const rows = extractTable(html, tableIdx);
  // rows[0] and rows[1] are headers; rows[2] is the first (latest) data row
  const data = rows[2];
  if (!data || data.length < 6) return null;

  const observedAt = parseToukantimestamp(data[0] ?? '');
  if (!observedAt) return null;

  const waterLevelM = parseNum(data[1] ?? '');
  const inflowM3s = parseNum(data[2] ?? '');
  const outflowM3s = parseNum(data[5] ?? ''); // 全放流量 = gate + power discharge
  const rainfallMm = parseNum(data[6] ?? '');

  if (waterLevelM === null && inflowM3s === null && outflowM3s === null) return null;

  return { observedAt, waterLevelM, inflowM3s, outflowM3s, rainfallMm };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 九州地方整備局 筑後川ダム統合管理事務所 — 2 dams: 松原/下筌 (筑後川水系, Oita)',
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

async function findDamId(cfg: DamCfg, log: (s: string) => void): Promise<bigint | null> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${cfg.prefCode} ORDER BY id
  `;
  const stem = cfg.masterName;
  // A row already stamped with this page keeps it (#57).
  const stamped = stampedMaster(masters, cfg.pageName);
  let best: { m: BindableMaster; rank: number } | null = stamped ? { m: stamped, rank: -1 } : null;
  for (const m of stamped ? [] : masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === cfg.pageName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  if (!best) {
    log(`${SOURCE_ID}: no master match for "${cfg.pageName}" in pref ${cfg.prefCode}`);
    return null;
  }
  await bindExternalId(best.m.id, SOURCE_ID, cfg.pageName);
  return best.m.id;
}

/** Resolve every dam the page publishes, keyed by its page name. */
async function matchMaster(log: (s: string) => void): Promise<Map<string, bigint>> {
  const matches = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const cfg of DAMS) {
    const damId = await findDamId(cfg, log);
    universe.push({
      externalId: cfg.pageName,
      name: cfg.pageName,
      prefCode: cfg.prefCode,
      resolvedDamId: damId,
    });
    if (damId) matches.set(cfg.pageName, damId);
  }
  await recordUniverse(SOURCE_ID, universe);
  return matches;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  // Resolved before the fetch so a bad page still leaves a scan on record.
  const damByPage = await matchMaster(log);

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const r = await fetch(DATA_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });

  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  const html = await r.text();
  const inputs: Parameters<typeof upsertObservations>[0] = [];

  // Tables in the page: index 0 is a decorative header table; indices 1 and 2 are dam data
  for (let i = 0; i < DAMS.length; i++) {
    const cfg = DAMS[i] as DamCfg;
    const row = parseToukantable(html, i + 1);
    if (!row) {
      log(`${SOURCE_ID}: no data row for ${cfg.pageName}`);
      continue;
    }
    log(`${SOURCE_ID}: ${cfg.pageName} at ${row.observedAt.toISOString()}`);

    const damId = damByPage.get(cfg.pageName);
    if (!damId) continue;

    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: row.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: written=${written}`);
};

export default task;
