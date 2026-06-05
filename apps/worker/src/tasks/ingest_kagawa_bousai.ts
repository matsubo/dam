// apps/worker/src/tasks/ingest_kagawa_bousai.ts
//
// かがわ防災Webポータル ダム諸量 — 18 ダム hourly.
//
//   椛川(試験湛水) / 門入 / 千足 / 内海 / 吉田 / 内場 / 野口 / 長柄 /
//   前山 / 殿川 / 粟井 / 五名 / 田万 / 大川 / 大内 / 五郷 / 府中 / 粟地
//
// Source:
//   https://www.bousai-kagawa.jp/bousai_data/tm/dam_station.json
//   Single JSON fetch; all 18 dams in one response; updated every 10 min.
//
// JSON schema per item:
//   station_name   — dam name
//   obs_datetime   — "YYYY/MM/DD HH:MM" JST
//   store          — 貯水位[m]
//   stored         — 貯水量[千m³]  → storageVolumeM3 × 1000
//   storage_rate   — 貯水率[%]     → storageRate ÷ 100  (clamped 0–1)
//   inflow         — 流入量[m³/s]
//   discharge      — 全放流量[m³/s]
//
// Priority 308. Cron hourly at :39.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.KAGAWA_BOUSAI_URL ?? 'https://www.bousai-kagawa.jp/bousai_data/tm/dam_station.json';

const PREF_CODE = '37';
const SOURCE_ID = 'kagawa-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  kagawaName: string;
  observedAt: Date | null;
  storageRate: number | null;
  storageVolumeM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

interface KagawaItem {
  station_name: string;
  obs_datetime: string;
  store: number | null;
  stored: number | null;
  storage_rate: number | null;
  inflow: number | null;
  discharge: number | null;
}

interface KagawaJson {
  result?: number;
  ret_time?: string;
  items?: KagawaItem[];
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" JST → UTC. Returns null on parse failure. */
export function parseKagawaTimestamp(s: string): Date | null {
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNum(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

export function parseKagawaItems(json: KagawaJson): ParsedRow[] {
  const rows: ParsedRow[] = [];

  for (const it of json.items ?? []) {
    const damName = it.station_name?.trim();
    if (!damName) continue;

    const observedAt = parseKagawaTimestamp(it.obs_datetime ?? '');
    const ratePct = toNum(it.storage_rate);
    const volRaw = toNum(it.stored);

    rows.push({
      kagawaName: damName,
      observedAt,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      waterLevelM: toNum(it.store),
      inflowM3s: toNum(it.inflow),
      outflowM3s: toNum(it.discharge),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            'かがわ防災Webポータル ダム諸量 — 18 ダム hourly JSON',
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
  kagawaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.kagawaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.kagawaName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.kagawaName}"`);
      continue;
    }
    out.push({ kagawaName: r.kagawaName, damId: best.id });
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

  const json = (await r.json()) as KagawaJson;
  const rows = parseKagawaItems(json);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.kagawaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.kagawaName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.kagawaName}"; skipping`);
      continue;
    }
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

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
