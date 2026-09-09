// apps/worker/src/tasks/ingest_saga_bousai.ts
//
// 佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム hourly.
//
//   岸川 / 庭木 / 繁昌 / 天ヶ瀬 / 平木場 / 伊岐佐 / 都川内 /
//   井手口川 / 竜門 / 有田 / 古木場 / 本部 / 矢筈 / 狩立日ノ峯 /
//   中木庭 / 岩屋川内 / 横竹 / 深浦 / 河内
//
// Source:
//   http://kasen.pref.saga.lg.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus
//   ?dk=4&sv=3&pg={1,2,3}
//   Shift_JIS HTML; 3 pages (7+7+5 dams). Table is *transposed*: dam names
//   are column headers, observation types are row labels (using ideographic
//   space U+3000 as separator).
//
// Observation rows extracted:
//   観測時刻       "MM/DD HH:MM" JST (per column)
//   貯水位 EL [m]
//   全流入量 [m3/s]
//   全放流量 [m3/s]
//   貯水量 [1000m3] → storageVolumeM3 × 1000  (some dams only)
//   貯水率 [%]     → storageRate ÷ 100         (some dams only)
//
// Year inferred from "YYYY年" pattern in the page header.
//
// Priority 308. Cron hourly at :40.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.SAGA_BOUSAI_URL ??
  'http://kasen.pref.saga.lg.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus';

const PREF_CODE = '41';
const SOURCE_ID = 'saga-bousai';
const PAGE_COUNT = 3;

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  sagaName: string;
  observedAt: Date | null;
  storageRate: number | null;
  storageVolumeM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse "MM/DD HH:MM" JST with an explicit year → UTC.
 * Returns null on parse failure.
 */
export function parseSagaTimestamp(s: string, year: number): Date | null {
  const m = s.match(/^(\d{1,2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number];
  const d = new Date(Date.UTC(year, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract the 4-digit year from "YYYY年..." in the page header.
 *
 * The table itself only carries MM/DD, so the year has to come from the header
 * or, failing that, the clock. The fallback uses the JST year because the page
 * reports JST: between 15:00 UTC on 31 Dec and midnight the UTC year is already
 * one behind what the page means.
 */
export function extractYear(html: string, now: Date = new Date()): number {
  const m = html.match(/(\d{4})年/);
  if (m) return Number(m[1]);
  return new Date(now.getTime() + 9 * 3_600_000).getUTCFullYear();
}

/**
 * Parse a single page's transposed dam table.
 * Returns one ParsedRow per dam column.
 */
export function parseSagaPage(html: string, now: Date = new Date()): ParsedRow[] {
  const year = extractYear(html, now);

  // Build label → [col values] from every <tr>
  const rowMap = new Map<string, string[]>();
  let damNames: string[] = [];

  for (const trMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rawCells = Array.from(
      (trMatch[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi),
    ).map((c) => cleanCell(c[1] ?? ''));

    if (rawCells.length < 2) continue;
    const label = rawCells[0] ?? '';

    if (label === '局名') {
      damNames = rawCells.slice(1);
    } else {
      rowMap.set(label, rawCells.slice(1));
    }
  }

  if (damNames.length === 0) return [];

  const timeRow = rowMap.get('観測時刻') ?? [];
  const levelRow = rowMap.get('貯水位 EL [m]') ?? [];
  const inflowRow = rowMap.get('全流入量 [m3/s]') ?? [];
  const outflowRow = rowMap.get('全放流量 [m3/s]') ?? [];
  const volRow = rowMap.get('貯水量 [1000m3]') ?? [];
  const rateRow = rowMap.get('貯水率 [%]') ?? [];

  const rows: ParsedRow[] = [];

  for (let i = 0; i < damNames.length; i++) {
    const sagaName = damNames[i] ?? '';
    if (!sagaName || (!sagaName.includes('ダム') && !sagaName.includes('貯水池'))) continue;

    const tsStr = timeRow[i] ?? '';
    const observedAt = parseSagaTimestamp(tsStr, year);

    const ratePct = parseNum(rateRow[i] ?? '');
    const volRaw = parseNum(volRow[i] ?? '');

    rows.push({
      sagaName,
      observedAt,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      storageVolumeM3: volRaw != null ? volRaw * 1000 : null,
      waterLevelM: parseNum(levelRow[i] ?? ''),
      inflowM3s: parseNum(inflowRow[i] ?? ''),
      outflowM3s: parseNum(outflowRow[i] ?? ''),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '佐賀県河川砂防情報システム ダム現況表 — 19 県管理ダム hourly (3-page Shift_JIS)',
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
  sagaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The 現況表
  // carries no station ids, so the published name is the key.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.sagaName);

    let best: { id: bigint; rank: number } | null = null;
    if (stem) {
      for (const m of masters) {
        const mStem = normalizeName(m.name);
        let rank: number;
        if (m.name === r.sagaName) rank = 0;
        else if (mStem === stem) rank = 1;
        else if (m.name === `${stem}ダム`) rank = 2;
        else if (mStem.startsWith(stem)) rank = 3;
        else if (stem.startsWith(mStem) && mStem.length >= 2) rank = 4;
        else if (mStem.includes(stem)) rank = 5;
        else continue;
        if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
          best = { id: m.id, rank };
        }
      }
    }

    universe.push({
      externalId: r.sagaName,
      name: r.sagaName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.sagaName}"`);
      continue;
    }
    out.push({ sagaName: r.sagaName, damId: best.id });
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Fetch all 3 pages in parallel
  const pageResults = await Promise.allSettled(
    Array.from({ length: PAGE_COUNT }, (_, i) =>
      fetch(`${BASE_URL}?dk=4&sv=3&pg=${i + 1}`, {
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(20_000),
      }),
    ),
  );

  const rows: ParsedRow[] = [];
  for (const result of pageResults) {
    if (result.status !== 'fulfilled') continue;
    const r = result.value;
    if (r.status !== 200) {
      log(`${SOURCE_ID}: HTTP ${r.status} on page fetch; skipping`);
      continue;
    }
    const raw = await r.arrayBuffer();
    const html = new TextDecoder('shift_jis').decode(raw);
    rows.push(...parseSagaPage(html));
  }

  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.sagaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.sagaName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.sagaName}"; skipping`);
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
