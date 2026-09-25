// apps/worker/src/tasks/ingest_skr_hiji.ts
//
// 国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 2 国管理ダム hourly (EUC-JP HTML).
//
//   野村ダム  (Ehime/38, 肱川水系)  obs_id 1368080276020
//   鹿野川ダム (Ehime/38, 肱川水系)  obs_id 1368080255010
//
// Source:
//   http://www1.river.go.jp/cgi-bin/DspDamData.exe?ID={obs_id}&KIND=3&PAGE=0
//   Outer page embeds an IFRAME pointing to the actual EUC-JP HTML data table.
//   The IFRAME URL is dynamic per request; must be parsed from the outer page.
//
// Format: 7 columns per <TR> in the IFRAME HTML:
//   [0] date "YYYY/MM/DD"
//   [1] time "HH:MM"
//   [2] rainfall mm
//   [3] storage 千m³  (× 1000 → m³)
//   [4] inflow  m³/s
//   [5] outflow m³/s
//   [6] storage rate % (→ / 100 = ratio)
//
// Priority 303 (MLIT-managed dam). Cron hourly at :23.

import { type BindableMaster, preferMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.WWW1_RIVER_DAM_BASE ?? 'http://www1.river.go.jp/cgi-bin/DspDamData.exe';

const SOURCE_ID = 'skr-hiji-dam';

// --- dam configuration -------------------------------------------------------

interface DamCfg {
  obsId: string;
  name: string;
  prefCode: string;
}

const DAM_CONFIG: DamCfg[] = [
  { obsId: '1368080276020', name: '野村ダム', prefCode: '38' },
  { obsId: '1368080255010', name: '鹿野川ダム', prefCode: '38' },
];

// --- types -------------------------------------------------------------------

export interface ParsedRow {
  obsId: string;
  observedAt: Date;
  rainfallMm: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageRate: number | null;
}

// --- parsing -----------------------------------------------------------------

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC. */
export function parseHijiTimestamp(date: string, time: string): Date | null {
  const dm = date.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const tm = time.trim().match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return null;
  const d = new Date(
    Date.UTC(
      Number(dm[1]),
      Number(dm[2]) - 1,
      Number(dm[3]),
      Number(tm[1]) - 9,
      Number(tm[2]),
      0,
      0,
    ),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseHijiIframeHtml(obsId: string, html: string): ParsedRow | null {
  const trMatches = Array.from(html.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi));

  for (const tr of trMatches) {
    const tds = Array.from((tr[1] ?? '').matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)).map((m) =>
      stripTags(m[1] ?? ''),
    );

    if (tds.length < 7) continue;

    const observedAt = parseHijiTimestamp(tds[0] ?? '', tds[1] ?? '');
    if (!observedAt) continue;

    const rainfallMm = parseNum(tds[2] ?? '');
    const storageThousandM3 = parseNum(tds[3] ?? '');
    const storageVolumeM3 = storageThousandM3 !== null ? storageThousandM3 * 1000 : null;
    const inflowM3s = parseNum(tds[4] ?? '');
    const outflowM3s = parseNum(tds[5] ?? '');
    const ratePct = parseNum(tds[6] ?? '');
    const storageRate = ratePct !== null ? Math.max(0, Math.min(1, ratePct / 100)) : null;

    if (storageVolumeM3 === null && inflowM3s === null && outflowM3s === null) continue;

    return { obsId, observedAt, rainfallMm, storageVolumeM3, inflowM3s, outflowM3s, storageRate };
  }

  return null;
}

// --- HTTP helpers ------------------------------------------------------------

async function fetchEucJp(url: string, ua: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) return null;
  const raw = await r.arrayBuffer();
  return new TextDecoder('euc-jp').decode(raw);
}

async function fetchDamRow(
  cfg: DamCfg,
  ua: string,
  log: (s: string) => void,
): Promise<ParsedRow | null> {
  const outerUrl = `${BASE_URL}?ID=${cfg.obsId}&KIND=3&PAGE=0`;
  const outerHtml = await fetchEucJp(outerUrl, ua);
  if (!outerHtml) {
    log(`${SOURCE_ID}: outer page failed for ${cfg.name}`);
    return null;
  }

  const iframeMatch = outerHtml.match(/<IFRAME[^>]+src="(\/html\/frm\/DamFree10Data[^"]+)"/i);
  if (!iframeMatch) {
    log(`${SOURCE_ID}: no IFRAME src for ${cfg.name}`);
    return null;
  }

  const iframeUrl = `http://www1.river.go.jp${iframeMatch[1]}`;
  const iframeHtml = await fetchEucJp(iframeUrl, ua);
  if (!iframeHtml) {
    log(`${SOURCE_ID}: IFRAME fetch failed for ${cfg.name}`);
    return null;
  }

  return parseHijiIframeHtml(cfg.obsId, iframeHtml);
}

// --- DB helpers --------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 四国地方整備局 肱川ダム統合管理事務所 — 野村・鹿野川ダム (Ehime)',
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

async function findDamId(
  name: string,
  prefCode: string,
  log: (s: string) => void,
): Promise<bigint | null> {
  const stem = normalizeName(name);

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear"
    FROM dams WHERE pref_code = ${prefCode} ORDER BY id
  `;

  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === name) rank = 0;
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
    log(`${SOURCE_ID}: no master match for "${name}" in pref ${prefCode}`);
    return null;
  }
  return best.m.id;
}

/** Resolve every dam this office publishes, keyed by its 観測所 id. */
async function matchMaster(log: (s: string) => void): Promise<Map<string, bigint>> {
  const matches = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const cfg of DAM_CONFIG) {
    const damId = await findDamId(cfg.name, cfg.prefCode, log);
    universe.push({
      externalId: cfg.obsId,
      name: cfg.name,
      prefCode: cfg.prefCode,
      resolvedDamId: damId,
    });
    if (damId) matches.set(cfg.obsId, damId);
  }
  await recordUniverse(SOURCE_ID, universe);
  return matches;
}

// --- task --------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Resolved before the fetches so a failing page still leaves a scan on record.
  const damByObs = await matchMaster(log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];

  for (const cfg of DAM_CONFIG) {
    const row = await fetchDamRow(cfg, ua, log);
    if (!row) continue;
    log(`${SOURCE_ID}: ${cfg.name} parsed at ${row.observedAt.toISOString()}`);

    const damId = damByObs.get(cfg.obsId);
    if (!damId) continue;

    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: null,
      rainfallMm: row.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${inputs.length} written=${written}`);
};

export default task;
