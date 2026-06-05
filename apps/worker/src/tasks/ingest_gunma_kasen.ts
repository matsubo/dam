// apps/worker/src/tasks/ingest_gunma_kasen.ts
//
// 群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly.
//
//   坂本ダム / 霧積ダム / 塩沢ダム / 四万川ダム /
//   道平川ダム / 大仁田ダム / 桐生川ダム
//
// Source:
//   https://www.river-gunma.jp/gunmaT/m4101/60/_0_{idx}_0.html
//   One Shift_JIS HTML page per station; indices 1–7.
//   Labels and values in <TD> pairs; dam name in <DIV align="center">;
//   timestamp in "MM月DD日HH時mm分現在" text (JST, no year).
//   Storage volume in 千m³; values may have → / ↑ / ↓ change arrows.
//
// Priority 308. Cron hourly at :48.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.GUNMA_KASEN_BASE_URL ?? 'https://www.river-gunma.jp/gunmaT/m4101/60/_0_{idx}_0.html';

const PREF_CODE = '10';
const SOURCE_ID = 'gunma-kasen';

// Station indices 1–7 with names confirmed from live pages
const STATIONS: ReadonlyArray<{ idx: number; name: string }> = [
  { idx: 1, name: '坂本ダム' },
  { idx: 2, name: '霧積ダム' },
  { idx: 3, name: '塩沢ダム' },
  { idx: 4, name: '四万川ダム' },
  { idx: 5, name: '道平川ダム' },
  { idx: 6, name: '大仁田ダム' },
  { idx: 7, name: '桐生川ダム' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  gunmaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * "MM月DD日HH時mm分現在" (JST, no year) → UTC.
 * Year is inferred from the current date; if the resulting datetime is more
 * than 24 hours in the future, the previous calendar year is used instead.
 */
export function parseGunmaTimestamp(s: string, now: Date = new Date()): Date | null {
  const m = s.match(/(\d{1,2})月(\d{1,2})日(\d{2})時(\d{2})分/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hh = Number(m[3]);
  const mi = Number(m[4]);
  if ([mo, dy, hh, mi].some(Number.isNaN)) return null;

  const yr = now.getFullYear();
  let d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  if (d.getTime() > now.getTime() + 86_400_000) {
    d = new Date(Date.UTC(yr - 1, mo - 1, dy, hh - 9, mi, 0, 0));
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVal(s: string): number | null {
  const t = s
    .replace(/[→↑↓←]/g, '')
    .replace(/,/g, '')
    .trim();
  if (!t || t === '-' || t === '---' || t === '****') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse a Gunma ダム現況表 Shift_JIS HTML page (already decoded to UTF-8 string). */
export function parseGunmaHtml(html: string, name: string): ParsedRow | null {
  // Extract timestamp from "MM月DD日HH時mm分現在" pattern
  const tsMatch = html.match(/(\d{1,2}月\d{1,2}日\d{2}時\d{2}分現在)/);
  if (!tsMatch?.[1]) return null;
  const observedAt = parseGunmaTimestamp(tsMatch[1]);
  if (!observedAt) return null;

  // Extract label→value pairs from <TD> rows
  const cells = Array.from(html.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((c) =>
    (c[1] ?? '').replace(/<[^>]+>/g, '').trim(),
  );

  let waterLevelM: number | null = null;
  let storageVolumeM3: number | null = null;
  let inflowM3s: number | null = null;
  let outflowM3s: number | null = null;

  for (let i = 0; i < cells.length - 1; i++) {
    const label = cells[i] ?? '';
    const value = cells[i + 1] ?? '';
    if (label.includes('貯水位')) {
      waterLevelM = parseVal(value);
    } else if (label.includes('貯水量')) {
      const raw = parseVal(value);
      storageVolumeM3 = raw != null ? raw * 1000 : null;
    } else if (label.includes('流入量')) {
      inflowM3s = parseVal(value);
    } else if (label.includes('放流量')) {
      outflowM3s = parseVal(value);
    }
  }

  if (waterLevelM === null && inflowM3s === null && outflowM3s === null) return null;

  return { gunmaName: name, observedAt, waterLevelM, storageVolumeM3, inflowM3s, outflowM3s };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '群馬県水位雨量情報システム ダム現況表 — 7 県管理ダム hourly',
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
  gunmaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.gunmaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.gunmaName) rank = 0;
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
      log(`${SOURCE_ID}: no master match for "${r.gunmaName}"`);
      continue;
    }
    out.push({ gunmaName: r.gunmaName, damId: best.id });
  }

  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const results = await Promise.allSettled(
    STATIONS.map(async ({ idx, name }) => {
      const url = BASE_URL.replace('{idx}', String(idx));
      const r = await fetch(url, {
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status !== 200) {
        log(`${SOURCE_ID}: idx=${idx} HTTP ${r.status}`);
        return null;
      }
      const buf = await r.arrayBuffer();
      const html = new TextDecoder('shift_jis').decode(buf);
      return parseGunmaHtml(html, name);
    }),
  );

  const rows: ParsedRow[] = results
    .filter((r): r is PromiseFulfilledResult<ParsedRow | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is ParsedRow => v !== null);

  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.gunmaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.gunmaName);
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
