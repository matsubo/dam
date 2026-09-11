// apps/worker/src/tasks/ingest_nara_kasen.ts
//
// 奈良県河川情報システム モバイル ダム現況 — 5 ダム, ~10分更新.
//
//   岩井川/天理/白川/初瀬/大門
//
// Source:
//   https://www.kasen.pref.nara.jp/sppub/status/dam_status.html
// Format: Shift_JIS HTML. 5 separate <table> blocks, one per dam.
//   Timestamp cell: "MM/DD&nbsp;HH:MM" (no year).
//   Value cells: "<img …>&nbsp;NNN.NN" (arrow image + value); "&nbsp;" alone → null.
//   Year inferred from current clock + rollover guard (Dec→Jan safety).
//   Columns: 貯水位[m] / 流入量[m³/s] / 放流量[m³/s]. No storage volume.
// Priority 308.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.NARA_KASEN_DAM_URL ?? 'https://www.kasen.pref.nara.jp/sppub/status/dam_status.html';

const PREF_CODE = '29';
const SOURCE_ID = 'nara-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  naraName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse a row timestamp "MM/DD HH:MM" (JST) → UTC.
 * Uses refDt (default: now) to infer the year; if the constructed date would be
 * more than 1 hour in the future, subtract a year (Dec→Jan rollover guard).
 */
export function parseNaraTimestamp(mmddHhmm: string, refDt: Date = new Date()): Date | null {
  // "MM/DD HH:MM" — &nbsp; replaced by the caller before passing
  const m = mmddHhmm.trim().match(/^(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  const hr = Number(m[3]);
  const mi = Number(m[4]);
  if (!Number.isFinite(mo + dy + hr + mi)) return null;

  // Use the JST year from refDt (shift +9h to get local JST date)
  const jstNow = new Date(refDt.getTime() + 9 * 3_600_000);
  let year = jstNow.getUTCFullYear();

  let d = new Date(Date.UTC(year, mo - 1, dy, hr - 9, mi, 0));
  if (Number.isNaN(d.getTime())) return null;

  if (d.getTime() > refDt.getTime() + 3_600_000) {
    year -= 1;
    d = new Date(Date.UTC(year, mo - 1, dy, hr - 9, mi, 0));
  }

  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip HTML tags and &nbsp;, parse a number; empty or whitespace-only → null. */
function parseCell(s: string): number | null {
  const clean = s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export function parseNaraPage(html: string, refDt: Date = new Date()): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/g;

  for (const tableM of html.matchAll(tableRe)) {
    const tableHtml = tableM[1];
    if (!tableHtml) continue;

    // Dam name
    const nameM = tableHtml.match(/class="sitename">(.*?)</);
    if (!nameM) continue;
    const naraName = (nameM[1] ?? '').trim();
    if (!naraName) continue;

    // The single data row: 4 consecutive <td class="ui-bar-g">…</td> cells.
    // First cell is timestamp; the other three are level, inflow, outflow.
    const cellRe = /<td class="ui-bar-g[^"]*">([\s\S]*?)<\/td>/g;
    const cells = [...tableHtml.matchAll(cellRe)].map((cm) => cm[1] ?? '');
    if (cells.length < 4) continue;

    const tsRaw = (cells[0] ?? '').replace(/&nbsp;/g, ' ').trim();
    const observedAt = parseNaraTimestamp(tsRaw, refDt);
    if (!observedAt) continue;

    const waterLevelM = parseCell(cells[1] ?? '');
    const inflowM3s = parseCell(cells[2] ?? '');
    const outflowM3s = parseCell(cells[3] ?? '');

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    rows.push({ naraName, observedAt, waterLevelM, inflowM3s, outflowM3s });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '奈良県河川情報システム ダム現況 — 5 ダム (Shift_JIS HTML, ~10分更新)',
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
  naraName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The
  // mobile page carries no station id, so the published name keyed by
  // prefecture is the stable identity.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.naraName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.naraName) rank = 0;
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
      externalId: r.naraName,
      name: r.naraName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });
    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.naraName}"`);
      continue;
    }
    out.push({ naraName: r.naraName, damId: best.id });
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
  const rows = parseNaraPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.naraName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.naraName);
    if (!damId) continue;
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
