// apps/worker/src/tasks/ingest_fukui_bousai.ts
//
// 福井県 河川・砂防総合情報システム ダム諸量現況表 — 13 ダム, hourly.
//
//   Prefectural: 永平寺/二ツ屋/浄土寺川/龍ヶ鼻/笹生川/桝谷/広野/河内川/大津呂/開谷/滝波
//   National (KKR-managed, also appear here): 真名川/九頭竜
//
// Source:
//   https://sabo.pref.fukui.lg.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4
// Format: Shift_JIS HTML. Single GET, no session. Standard 防災Web table.
// Columns per dam row:
//   局名 | 所在地 | 最新観測時刻 | 貯水率(利水容量)[%] | 貯水位[m] |
//   有効貯水量[10³m³] | 流入量[m³/s] | 放流量[m³/s] | 管理者名
// Timestamp per dam: "YYYY&nbsp;MM/DD&nbsp;HH:MM" JST.
// Missing: "---" or "&nbsp;" → null. Storage in 10³m³ (千m³).
// Priority 308. Upgrades kkr-mlit-dam (priority 302, daily) for 真名川/九頭竜.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { type UniverseRow, recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.FUKUI_BOUSAI_DAM_URL ??
  'https://sabo.pref.fukui.lg.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREF_CODE = '18';
const SOURCE_ID = 'fukui-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  fukuiName: string;
  observedAt: Date;
  storageRate: number | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY&nbsp;MM/DD&nbsp;HH:MM" or "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseFukuiTimestamp(s: string): Date | null {
  const clean = s.replace(/&nbsp;/g, ' ').trim();
  const m = clean.match(/(\d{4})\s+(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Strip HTML entities (&rarr; &darr; &uarr; &nbsp;) and parse a number; "---" → null */
function parseVal(s: string): number | null {
  const clean = s.replace(/&[a-z]+;/g, '').trim();
  if (clean === '---' || clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// Each dam row is on one line; columns: name | location | timestamp |
// storageRate | waterLevel | storage | inflow | outflow | manager.
// Module-level so parseFukuiNames can share it: String.matchAll clones the
// regex, so the two callers cannot leak lastIndex into each other.
const ROW_RE =
  /<td[^>]+class="normal[01]">[^<]*<a[^>]+>([^<]+)<\/a>[^<]*<\/td><td[^>]+class="normal[01]">[^<]*<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">([^<]*)<\/td><td[^>]+class="normal[01]">[^<]*<\/td>/g;

export function parseFukuiPage(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const fukuiName = m[1]?.trim() ?? '';
    if (!fukuiName) continue;

    const observedAt = parseFukuiTimestamp(m[2] ?? '');
    if (!observedAt) continue;

    const storageRatePct = parseVal(m[3] ?? '');
    const storageRate = storageRatePct !== null ? storageRatePct / 100 : null;
    const waterLevelM = parseVal(m[4] ?? '');
    const rawStorage = parseVal(m[5] ?? '');
    const inflowM3s = parseVal(m[6] ?? '');
    const outflowM3s = parseVal(m[7] ?? '');

    if (
      storageRate === null &&
      waterLevelM === null &&
      rawStorage === null &&
      inflowM3s === null &&
      outflowM3s === null
    )
      continue;

    rows.push({
      fukuiName,
      observedAt,
      storageRate,
      waterLevelM,
      storageVolumeM3: rawStorage !== null ? rawStorage * 1_000 : null,
      inflowM3s,
      outflowM3s,
    });
  }

  return rows;
}

/**
 * Every dam the 現況表 lists, whatever it currently reports.
 *
 * parseFukuiPage drops a row whose timestamp won't parse or whose values are
 * all "---", which is right for observations and wrong for the universe: an
 * offline dam is still a dam this source publishes. Recording only the rows
 * that survived those guards would let a permanently-quiet station stay out
 * of source_universe forever, and /coverage would then report its dam as
 * 提供元なし — the exact false negative the table exists to prevent.
 */
export function parseFukuiNames(html: string): string[] {
  const names: string[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const fukuiName = m[1]?.trim() ?? '';
    if (fukuiName) names.push(fukuiName);
  }
  return names;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '福井県河川・砂防総合情報システム ダム諸量現況表 — 13 ダム (Shift_JIS HTML, hourly)',
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
  fukuiName: string;
  damId: bigint;
}

/**
 * Pick the best master dam for a published name: an exact raw-name hit beats a
 * stem hit beats a prefix/substring hit, ties going to the lower id.
 */
function chooseMaster(
  rawName: string,
  stem: string,
  masters: { id: bigint; name: string }[],
): bigint | null {
  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === rawName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

async function matchMaster(
  rows: ParsedRow[],
  publishedNames: string[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.fukuiName);
    if (!stem) continue;

    const damId = chooseMaster(r.fukuiName, stem, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.fukuiName}"`);
      continue;
    }
    out.push({ fukuiName: r.fukuiName, damId });
  }

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Built
  // from every name the 現況表 lists, not from `rows`: a dam reporting "---"
  // across the board never survives parseFukuiPage, and recording only the
  // parsed subset would eventually have /coverage claim nobody publishes it.
  const universe: UniverseRow[] = publishedNames.map((fukuiName) => ({
    externalId: fukuiName,
    name: fukuiName,
    prefCode: PREF_CODE,
    resolvedDamId: chooseMaster(fukuiName, normalizeName(fukuiName), masters),
  }));
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
  const rows = parseFukuiPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, parseFukuiNames(html), log);
  const damByName = new Map(matches.map((m) => [m.fukuiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.fukuiName);
    if (!damId) continue;
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
