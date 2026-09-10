// apps/worker/src/tasks/ingest_jwa_chiba.ts
//
// 水資源機構 千葉用水総合管理所 房総導水路管理所 — 2 JWA管理ダム 日次.
//
//   長柄ダム (千葉 12) / 東金ダム (千葉 12)
//
// Source:
//   https://www.water.go.jp/kanto/bouso/01shinchaku/syusuijouhou/syusuijouhou.html
// Format: UTF-8 HTML, manually updated on business days (閉庁日を除き).
//   Timestamp: "令和X年Y月Z日（0時現在）" — midnight JST of the stated date.
//   Values embedded between HTML comments:
//     <!-- ↓↓↓↓↓{ダム}の水位を入力↓↓↓↓↓ -->  水位　 E.L. XX.XXm  <!-- ↑↑... -->
//     <!-- ↓↓↓↓↓{ダム}の貯水率を入力↓↓↓↓↓ --> 貯水率　　XX.X %  <!-- ↑↑... -->
// Coverage:
//   Not on 千葉県水道局 page (pref water supply dams are different facilities).
//   Only water level (EL.m) + storage rate (%) — no volume or flow.
// Priority: 302 (国/JWA管理, daily, same as kkr-mlit-dam).
// Cron: daily at 03:00 UTC = 12:00 JST.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.JWA_CHIBA_BOUSO_URL ??
  'https://www.water.go.jp/kanto/bouso/01shinchaku/syusuijouhou/syusuijouhou.html';

const PREF_CODE = '12';
const SOURCE_ID = 'jwa-chiba-bouso';

const DAMS: ReadonlyArray<{ htmlName: string; masterName: string }> = [
  { htmlName: '長柄ダム', masterName: '長柄' },
  { htmlName: '東金ダム', masterName: '東金' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  htmlName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse "令和X年Y月Z日（0時現在）" (midnight JST) → UTC.
 * 令和 era: Gregorian year = 2018 + reiwa year.
 */
export function parseJwaChibaTimestamp(html: string): Date | null {
  const m = html.match(/令和(\d+)年(\d+)月(\d+)日（0時現在）/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  if ([yr, mo, dy].some(Number.isNaN)) return null;
  // Midnight JST (UTC+9) → UTC: subtract 9 hours
  const d = new Date(Date.UTC(yr, mo - 1, dy, -9, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract the value between a start-comment and the next end-comment. */
function extractBetweenComments(html: string, startMarker: string): string {
  const startIdx = html.indexOf(startMarker);
  if (startIdx < 0) return '';
  const afterStart = html.indexOf('-->', startIdx) + 3;
  const endIdx = html.indexOf('<!--', afterStart);
  return endIdx > afterStart ? html.slice(afterStart, endIdx) : html.slice(afterStart);
}

/** Parse all fields for one dam from the page HTML. */
export function parseDam(html: string, htmlName: string, observedAt: Date): ParsedRow | null {
  // Water level: "水位　 E.L. 74.18m"
  const levelSection = extractBetweenComments(html, `↓↓↓↓↓${htmlName}の水位を入力↓↓↓↓↓`);
  const levelMatch = levelSection.match(/E\.L\.\s*([\d.]+)\s*m/);
  const waterLevelM = levelMatch ? Number(levelMatch[1]) : null;

  // Storage rate: "貯水率　　92.5 %" → divide by 100 → [0, 1] fraction
  const rateSection = extractBetweenComments(html, `↓↓↓↓↓${htmlName}の貯水率を入力↓↓↓↓↓`);
  const rateMatch = rateSection.match(/([\d.]+)\s*%/);
  const storageRate = rateMatch ? Math.max(0, Math.min(1, Number(rateMatch[1]) / 100)) : null;

  if (waterLevelM === null && storageRate === null) return null;

  return { htmlName, observedAt, waterLevelM, storageRate };
}

/** Parse the full JWA Chiba page. */
export function parseJwaChibaHtml(html: string): ParsedRow[] {
  const observedAt = parseJwaChibaTimestamp(html);
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];
  for (const dam of DAMS) {
    const row = parseDam(html, dam.htmlName, observedAt);
    if (row) rows.push(row);
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 302,
            '水資源機構 千葉用水総合管理所 — 長柄・東金ダム日次 (EL水位+貯水率)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

/**
 * Pick the best master dam for a published name: an exact page-name hit beats
 * 「<stem>ダム」 beats the bare stem beats a prefix hit beats a substring hit,
 * ties going to the lower id.
 */
function chooseMaster(
  htmlName: string,
  stem: string,
  masters: { id: bigint; name: string }[],
): bigint | null {
  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    let rank: number;
    if (m.name === htmlName) rank = 0;
    else if (m.name === `${stem}ダム`) rank = 1;
    else if (m.name === stem) rank = 2;
    else if (m.name.startsWith(stem)) rank = 3;
    else if (m.name.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

async function matchMaster(
  rows: ParsedRow[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out = new Map<string, bigint>();

  for (const r of rows) {
    const dam = DAMS.find((d) => d.htmlName === r.htmlName);
    if (!dam) continue;

    const damId = chooseMaster(r.htmlName, dam.masterName, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.htmlName}"`);
      continue;
    }
    out.set(r.htmlName, damId);
  }

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Built
  // from DAMS, not from `rows`: the page lists both dams even on a day when
  // one carries no 水位/貯水率 to parse, and recording only the parsed subset
  // would eventually have /coverage claim nobody publishes it.
  const universe: UniverseRow[] = DAMS.map((d) => ({
    externalId: d.htmlName,
    name: d.htmlName,
    prefCode: PREF_CODE,
    resolvedDamId: chooseMaster(d.htmlName, d.masterName, masters),
  }));
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

  const r = await fetch(PAGE_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}`);
    return;
  }
  const html = await r.text();

  const rows = parseJwaChibaHtml(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const damMap = await matchMaster(rows, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damMap.get(p.htmlName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damMap.size} written=${written}`);
};

export default task;
