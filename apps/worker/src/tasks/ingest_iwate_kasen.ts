// apps/worker/src/tasks/ingest_iwate_kasen.ts
//
// 岩手県河川情報システム ダム諸量経過表 — 防災Web-style servlet, hourly.
//
//   10 県管理ダム: 綱取(中津川) / 簗川(簗川) / 滝(長内川) /
//   入畑(夏油川) / 日向(小川川) / 早池峰(稗貫川) /
//   綾里川(綾里川) / 鷹生(鷹生川) / 遠野(来内川) / 遠野第二(来内川).
//
// Source:
//   http://kasen.pref.iwate.jp/iwate/servlet/Gamen32Servlet?param=station=N
//   One request per station (N=0..9); the server returns Shift_JIS HTML with
//   the most recent 24-hour time-series for that dam.
// Format: Shift_JIS HTML, `<div class="dat2">` cells per column:
//   [0] 貯水位(ELm) [1] 貯水量(千m³) [2] 空容量(千m³)
//   [3] 全流入量(m³/s) [4] ゲート放流量 [5] 使用水量
//   [6] 全放流量(m³/s) [7] 調整流量
// Timestamp: "<td class=\"ListDate\">MM/DD&nbsp;HH:MM</td>" JST; year from
//   commonParam "dispDate:YYYY-MM-DD-HH-MM" embedded in the response HTML.
// Priority 308, matching other prefectural sources.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.IWATE_KASEN_URL ?? 'http://kasen.pref.iwate.jp/iwate/servlet/Gamen32Servlet';

const PREF_CODE = '03';
const SOURCE_ID = 'iwate-kasen';

// Station index → (stationNo, dam name).  Index matches the server's dropdown
// order; stationNo is used for external_ids only.
interface StationCfg {
  readonly idx: number;
  readonly stationNo: string;
  readonly name: string;
}

const STATIONS: StationCfg[] = [
  { idx: 0, stationNo: '103007003', name: '綱取ダム' },
  { idx: 1, stationNo: '103007002', name: '簗川ダム' },
  { idx: 2, stationNo: '103007001', name: '滝ダム' },
  { idx: 3, stationNo: '103007011', name: '入畑ダム' },
  { idx: 4, stationNo: '103007004', name: '日向ダム' },
  { idx: 5, stationNo: '103007008', name: '早池峰ダム' },
  { idx: 6, stationNo: '103007006', name: '綾里川ダム' },
  { idx: 7, stationNo: '103007005', name: '鷹生ダム' },
  { idx: 8, stationNo: '103007012', name: '遠野ダム' },
  { idx: 9, stationNo: '103007016', name: '遠野第二ダム' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  iwateName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '-' || t === '―' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Extract year from the embedded commonParam "dispDate:YYYY-MM-DD-HH-MM$..." */
export function extractYear(html: string): number {
  const m = html.match(/var commonParam = "[^"]*dispDate:(\d{4})/);
  return m ? Number(m[1]) : new Date().getUTCFullYear();
}

/** "MM/DD HH:MM" JST + year → UTC Date */
export function parseIwateTimestamp(rowDate: string, year: number): Date | null {
  const m = rowDate.match(/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hr = Number(m[3]);
  const mi = Number(m[4]);
  const d = new Date(Date.UTC(year, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the most recent row from a Gamen32Servlet response for one dam.
 * Finds the first ListDate cell, then collects the next 8 dat2 values.
 */
export function parseIwatePage(html: string, iwateName: string): ParsedRow {
  const year = extractYear(html);

  // First ListDate cell → timestamp
  const dateMatch = html.match(/<td[^>]+class="ListDate"[^>]*>([\s\S]*?)<\/td>/);
  const rawDate = dateMatch
    ? (dateMatch[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .trim()
    : '';
  const observedAt = rawDate ? parseIwateTimestamp(rawDate, year) : null;

  // dat2 values after the first ListDate cell position
  const startPos = dateMatch ? html.indexOf(dateMatch[0]) + dateMatch[0].length : 0;
  const dat2Re = /<div class="dat2"><span[^>]*>([\s\S]*?)<\/span><\/div>/g;
  dat2Re.lastIndex = startPos;
  const vals: Array<number | null> = [];
  for (let i = 0; i < 8; i++) {
    const hit = dat2Re.exec(html);
    if (!hit) break;
    vals.push(parseNum((hit[1] ?? '').trim()));
  }

  const storageThou = vals[1] ?? null;
  return {
    iwateName,
    observedAt,
    waterLevelM: vals[0] ?? null,
    storageVolumeM3: storageThou !== null ? storageThou * 1_000 : null,
    inflowM3s: vals[3] ?? null,
    outflowM3s: vals[6] ?? null,
  };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '岩手県河川情報システム — Gamen32Servlet, 10 dams, hourly',
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
  iwateName: string;
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
    const stem = normalizeName(r.iwateName);
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

    universe.push({
      externalId: STATIONS.find((s) => s.name === r.iwateName)?.stationNo ?? r.iwateName,
      name: r.iwateName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });
    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.iwateName}"`);
      continue;
    }

    out.push({ iwateName: r.iwateName, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.iwateName}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.iwateName}
    `;
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const headers = {
  'user-agent':
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
};

async function fetchStation(stn: StationCfg): Promise<ParsedRow | null> {
  const url = `${BASE_URL}?param=station=${stn.idx}`;
  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) return null;
  const raw = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(raw);
  return parseIwatePage(html, stn.name);
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const results = await Promise.all(STATIONS.map((stn) => fetchStation(stn)));
  const rows = results.filter((r): r is ParsedRow => r !== null);
  log(`${SOURCE_ID}: fetched ${rows.length}/${STATIONS.length} stations`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.iwateName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.iwateName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.iwateName}"; skipping`);
      continue;
    }
    if (p.waterLevelM === null) continue;

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
  log(`${SOURCE_ID} done: fetched=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
