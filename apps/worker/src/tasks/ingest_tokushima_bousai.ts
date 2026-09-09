// apps/worker/src/tasks/ingest_tokushima_bousai.ts
//
// 徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム, 10分更新.
//
//   7 dams: 長安口/福井/川口/正木/宮川内/棚野/池田(水)
//
// Source:
//   https://www.kasen.pref.tokushima.lg.jp/sp/status/dam_status.html
// Format: Shift_JIS HTML, no session. 3 columns per dam: 貯水位(m) / 流入量(m³/s) / 放流量(m³/s).
// Individual per-dam timestamps: "MM/DD HH:MM" JST (no year).
// Priority 308.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.TOKUSHIMA_BOUSAI_URL ??
  'https://www.kasen.pref.tokushima.lg.jp/sp/status/dam_status.html';

const PREF_CODE = '36';
const SOURCE_ID = 'tokushima-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  tokushimaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * "MM/DD HH:MM" JST → UTC Date.
 * Year is supplied by caller; handles Dec→Jan crossover for real-time data.
 */
export function parseTokushimaTimestamp(s: string, currentYear: number): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hr = Number(m[3]);
  const mi = Number(m[4]);
  if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
  const d = new Date(Date.UTC(currentYear, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const clean = s.replace(/[^\d.\-]/g, '').trim();
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

/** Strip HTML tags and &nbsp; from a cell value string */
function extractText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function parseTokushimaTable(html: string, currentYear: number): ParsedRow[] {
  const rows: ParsedRow[] = [];

  // Split on dam sections: each dam starts at <span class="sitename">
  const sectionRe = /<span class="sitename">([^<]+)<\/span>/g;
  const sectionMatches = [...html.matchAll(sectionRe)];

  for (let i = 0; i < sectionMatches.length; i++) {
    const match = sectionMatches[i];
    if (!match) continue;
    const name = match[1]?.trim() ?? '';
    const sectionStart = match.index ?? 0;
    const sectionEnd =
      i + 1 < sectionMatches.length
        ? (sectionMatches[i + 1]?.index ?? sectionStart + 3000)
        : sectionStart + 3000;
    const section = html.slice(sectionStart, sectionEnd);

    // Find the observation data row: a line with 3-4 <td class="ui-bar-g..."> cells
    // First td is timestamp, next 3 are water level / inflow / outflow
    const tdRe = /<td[^>]*class="ui-bar-g[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
    const tds = [...section.matchAll(tdRe)];
    if (tds.length < 4) continue;

    const tsText = extractText(tds[0]?.[1] ?? '');
    const observedAt = parseTokushimaTimestamp(tsText, currentYear);
    if (!observedAt) continue;

    const lv = extractText(tds[1]?.[1] ?? '');
    const inflow = extractText(tds[2]?.[1] ?? '');
    const outflow = extractText(tds[3]?.[1] ?? '');

    rows.push({
      tokushimaName: name,
      observedAt,
      waterLevelM: parseNum(lv),
      inflowM3s: parseNum(inflow),
      outflowM3s: parseNum(outflow),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '徳島県河川砂防水位観測所 ダム諸量情報 — 7 ダム (Shift_JIS HTML, 10分更新)',
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
  tokushimaName: string;
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
    const stem = normalizeName(r.tokushimaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.tokushimaName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    universe.push({
      externalId: r.tokushimaName,
      name: r.tokushimaName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });
    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.tokushimaName}"`);
      continue;
    }

    out.push({ tokushimaName: r.tokushimaName, damId: best.id });
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

  const raw = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(raw);
  const currentYear = new Date().getUTCFullYear();
  const rows = parseTokushimaTable(html, currentYear);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.tokushimaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.tokushimaName);
    if (!damId) continue;
    if (p.waterLevelM === null && p.inflowM3s === null && p.outflowM3s === null) continue;

    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
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
