// apps/worker/src/tasks/ingest_saitama_suibo.ts
//
// 埼玉県 川の防災情報 ダム諸量 — 9 ダム hourly.
//
//   合角ダム / 有間ダム / 権現堂調節池 (県管理) /
//   渡良瀬遊水地 / 二瀬ダム / 荒川第一調節池 /
//   浦山ダム / 滝沢ダム / 下久保ダム (国管理)
//
// Source:
//   https://suibo-river.pref.saitama.lg.jp/hyoujidata/dinfo.csv
//   UTF-8 CSV; one row per dam; no header.
//
// CSV columns (from commonConfig.js csvDef.dinfo):
//   col[0] = 地点番号 (station code)
//   col[1] = 状態 (status)
//   col[2] = 放流量 [m³/s]
//   col[3] = 流入量 [m³/s]
//   col[4] = 貯水位 [EL.m]
//   col[5] = 貯水量 [千m³] → storageVolumeM3 × 1000
//   col[6] = 貯水率 [%]
//   col[7] = 観測時刻 "YYYYMMDDHHmm" JST
//   col[8] = 管轄事務所名
//   Missing values encoded as "c", "*", empty.
//   Volume column uses comma-formatted numbers (e.g. "4,518").
//
// Priority 308. Cron hourly at :44.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.SAITAMA_SUIBO_URL ?? 'https://suibo-river.pref.saitama.lg.jp/hyoujidata/dinfo.csv';

const PREF_CODE = '11';
const SOURCE_ID = 'saitama-suibo';

// Station map from chitenconfig/DamList.csv
const STATION_MAP: Readonly<Record<string, string>> = {
  '55301100001': '合角ダム',
  '55301100002': '有間ダム',
  '55301100003': '権現堂調節池',
  '12330100001': '渡良瀬遊水地',
  '12331600001': '二瀬ダム',
  '12330800004': '荒川第一調節池',
  '12330800005': '浦山ダム',
  '12330800006': '滝沢ダム',
  '12331400006': '下久保ダム',
};

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  /** 地点番号 — the portal's own station code, stable across runs. */
  code: string;
  saitamaName: string;
  observedAt: Date;
  outflowM3s: number | null;
  inflowM3s: number | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYYMMDDHHmm" (12 chars, JST) → UTC. Returns null on failure. */
export function parseSaitamaTimestamp(s: string): Date | null {
  if (s.length !== 12) return null;
  const yr = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const dy = Number(s.slice(6, 8));
  const hh = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  if ([yr, mo, dy, hh, mi].some(Number.isNaN)) return null;
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVal(s: string): number | null {
  if (!s || s === 'c' || s === '*' || s === '****' || s === '---') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** Split one CSV line respecting RFC 4180 quoting. */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

export function parseSaitamaCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = splitCsvLine(line);
    if (cols.length < 8) continue;

    const code = (cols[0] ?? '').trim();
    const saitamaName = STATION_MAP[code];
    if (!saitamaName) continue;

    const ts = (cols[7] ?? '').trim();
    const observedAt = parseSaitamaTimestamp(ts);
    if (!observedAt) continue;

    const outflowM3s = parseVal(cols[2] ?? '');
    const inflowM3s = parseVal(cols[3] ?? '');
    const waterLevelM = parseVal(cols[4] ?? '');
    const volRaw = parseVal(cols[5] ?? '');

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({
      code,
      saitamaName,
      observedAt,
      outflowM3s,
      inflowM3s,
      waterLevelM,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '埼玉県 川の防災情報 ダム諸量 — 9 ダム hourly CSV',
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
    .replace(/調節池$/, '')
    .replace(/遊水地$/, '')
    .trim();
}

interface DamMatch {
  saitamaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string; pref_code: string }[]>`
    SELECT id, name, pref_code FROM dams
    WHERE pref_code IN (${PREF_CODE}, '09', '10', '13')
    ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Seeded
  // from the station map rather than from this run's rows, so a dam whose CSV
  // row is empty today still counts as published; the resolved rows pushed
  // below supersede these (recordUniverse keeps the last entry per id).
  const universe: UniverseRow[] = Object.entries(STATION_MAP).map(([code, name]) => ({
    externalId: code,
    name,
    prefCode: PREF_CODE,
    resolvedDamId: null,
  }));

  for (const r of rows) {
    const stem = normalizeName(r.saitamaName);

    let best: { id: bigint; rank: number } | null = null;
    if (stem) {
      for (const m of masters) {
        const mStem = normalizeName(m.name);
        let rank: number;
        if (m.name === r.saitamaName) rank = 0;
        else if (mStem === stem) rank = 1;
        else if (m.name === `${stem}ダム`) rank = 2;
        else if (mStem.startsWith(stem)) rank = 3;
        else if (mStem.includes(stem)) rank = 4;
        else continue;
        if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
          best = { id: m.id, rank };
        }
      }
    }

    universe.push({
      externalId: r.code,
      name: r.saitamaName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.saitamaName}"`);
      continue;
    }
    out.push({ saitamaName: r.saitamaName, damId: best.id });
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

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

  const text = await r.text();
  const rows = parseSaitamaCsv(text);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.saitamaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.saitamaName);
    if (!damId) continue;
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
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
