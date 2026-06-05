// apps/worker/src/tasks/ingest_wakayama_kasen.ts
//
// 和歌山県河川／雨量防災情報 ダム諸量 — 19 ダム hourly.
//
//   広川 / 二川 / 椿山 / 七川 / 切目川 / 殿山 / 小匠 /
//   猿谷 / 九尾 / 川迫 / 大滝 / 大迫 / 津風呂 /
//   坂本 / 池原 / 七色 / 二津野 / 小森 / 風屋
//
// Source:
//   http://kasensabo01.pref.wakayama.lg.jp/hyoujidata/dinfo.csv
//   (follows redirect to HTTPS)
//   Single CSV fetch; one row per dam; no header; EUC-JP encoded.
//
// CSV columns (from commonConfig.js csvDef.dinfo):
//   col[0] = 地点番号 (station code)
//   col[1] = 状態 (status)
//   col[2] = 放流量 [m³/s]
//   col[3] = 流入量 [m³/s]
//   col[4] = 貯水位 [m]
//   col[5] = 貯水量 [千m³] → storageVolumeM3 × 1000
//   col[6] = 観測時刻 "YYYYMMDDHHmm" JST
//   Missing values are encoded as "****".
//
// Priority 308. Cron hourly at :41.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.WAKAYAMA_KASEN_URL ?? 'http://kasensabo01.pref.wakayama.lg.jp/hyoujidata/dinfo.csv';

const PREF_CODE = '30';
const SOURCE_ID = 'wakayama-kasen';

// Station map from commonConfig.js DMCD_* constants.
// col[0] station code → dam name (Wakayama name used for master matching).
const STATION_MAP: Readonly<Record<string, string>> = {
  '450': '広川ダム',
  '470': '二川ダム',
  '550': '椿山ダム',
  '750': '七川ダム',
  '502': '切目川ダム',
  '601': '殿山ダム',
  '801': '小匠ダム',
  '22077001': '猿谷ダム',
  '22077002': '九尾ダム',
  '22077003': '川迫ダム',
  '22077006': '大滝ダム',
  '22077004': '大迫ダム',
  '22077005': '津風呂ダム',
  '22088001': '坂本ダム',
  '22088002': '池原ダム',
  '22088003': '七色ダム',
  '22088004': '二津野ダム',
  '22088005': '小森ダム',
  '22088006': '風屋ダム',
};

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  wakayamaName: string;
  observedAt: Date;
  outflowM3s: number | null;
  inflowM3s: number | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYYMMDDHHmm" (12 chars, JST) → UTC. Returns null on failure. */
export function parseWakayamaTimestamp(s: string): Date | null {
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
  if (!s || s === '****' || s === '---' || s === '--' || s === '*') return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseWakayamaCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split(',');
    if (cols.length < 7) continue;

    const code = (cols[0] ?? '').trim();
    const wakayamaName = STATION_MAP[code];
    if (!wakayamaName) continue;

    const ts = (cols[6] ?? '').trim();
    const observedAt = parseWakayamaTimestamp(ts);
    if (!observedAt) continue;

    const outflowM3s = parseVal(cols[2] ?? '');
    const inflowM3s = parseVal(cols[3] ?? '');
    const waterLevelM = parseVal(cols[4] ?? '');
    const volRaw = parseVal(cols[5] ?? '');

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({
      wakayamaName,
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
            '和歌山県河川防災情報 ダム諸量 — 19 ダム hourly CSV',
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
  wakayamaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.wakayamaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.wakayamaName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.wakayamaName}"`);
      continue;
    }
    out.push({ wakayamaName: r.wakayamaName, damId: best.id });
  }

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

  const buf = await r.arrayBuffer();
  const text = new TextDecoder('euc-jp').decode(buf);
  const rows = parseWakayamaCsv(text);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.wakayamaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.wakayamaName);
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
