// apps/worker/src/tasks/ingest_miyagi_kasen.ts
//
// 宮城県土木総合情報システム ダム現況表 — 21 ダム, hourly.
//
//   18 県管理: 大倉/樽水/七北田/南川/宮床/惣の関/川内沢/漆沢/化女沼/
//              上大沢/二ツ石/岩堂沢/花山/荒砥沢/小田/栗駒/長沼/払川
//    3 国管理: 鳴子/釜房/七ヶ宿 (MLIT Tohoku)
//
// Source:
//   https://www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet
// Format: Shift_JIS HTML, no session. Two GETs per run: the latest table and
// the previous hour (most stations report well after the table flips hours).
// Columns per dam (10 values after name/manager):
//   [0] 貯水位 (EL.m)
//   [1] 貯水量 (10³m³)
//   [2] 空容量 (10³m³)      — not stored
//   [3] 全流入量 (m³/s)
//   [4] 全放流量 (m³/s)
//   [5] 調整流量 (m³/s)     — not stored
//   [6] 流域平均雨量 (mm)   — not stored
//   [7] 流域平均累加雨量 (mm)— not stored
//   [8] 貯水率(利水容量) (%)
//   [9] 貯水率(有効容量) (%) — not stored (use [8])
// Timestamp: "観測時刻：YYYY年MM月DD日 HH時MM分" JST.
// Priority 308, matching other 防災Web prefectural sources.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.MIYAGI_KASEN_URL ??
  'https://www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet';

const PREF_CODE = '04';
const SOURCE_ID = 'miyagi-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  miyagiName: string;
  stationNo: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY年MM月DD日 HH時MM分" JST → UTC Date */
export function parseMiyagiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{2})時(\d{2})分/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "YYYY-MM-DD-HH-MM" JST (from commonParam.dispDate) → UTC Date.
 * The site now renders 観測時刻 dynamically; dispDate in the inline JS is the
 * authoritative timestamp when the label element is empty.
 */
export function parseMiyagiDispDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The same 現況表 `hoursBack` hours before the page's own dispDate, requested
 * the way the site's 時刻切替 buttons do: the page's commonParam with dispDate
 * replaced, passed as `?param=common=…` and encodeURI'd. Null when the page
 * carries no commonParam to rewrite.
 */
export function earlierTableUrl(baseUrl: string, html: string, hoursBack: number): string | null {
  const common = html.match(/var commonParam = "([^"]*)"/)?.[1];
  const disp = common?.match(/dispDate:(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})/)?.[1];
  const at = disp ? parseMiyagiDispDate(disp) : null;
  if (!common || !at) return null;
  // Shift into JST wall-clock so the UTC getters read JST fields.
  const jst = new Date(at.getTime() + (9 - hoursBack) * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  const earlier = `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}-${p(jst.getUTCHours())}-${p(jst.getUTCMinutes())}`;
  const rewritten = common.replace(/dispDate:[^$]*/, `dispDate:${earlier}`);
  return `${baseUrl}?param=${encodeURI(`common=${rewritten}`)}`;
}

function parseNum(s: string): number | null {
  const clean = s.replace(/[^\d.-]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export function parseMiyagiTable(html: string): ParsedRow[] {
  // Primary: inline "観測時刻：YYYY年MM月DD日 HH時MM分" label (older site format).
  // Fallback: commonParam.dispDate "YYYY-MM-DD-HH-MM" injected by JS (current format).
  const tsLabelMatch = html.match(
    /観測時刻[：:]\s*(\d{4})年(\d{2})月(\d{2})日\s+(\d{2})時(\d{2})分/,
  );
  const dispDateMatch = html.match(/dispDate:(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})/);

  const observedAt = tsLabelMatch
    ? parseMiyagiTimestamp(tsLabelMatch[0])
    : dispDateMatch
      ? parseMiyagiDispDate(dispDateMatch[1] ?? '')
      : null;
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];

  // Each dam section starts at: stationNo','XXXXXX'")>DAM_NAME</span>
  // followed by 10 <div class="dat2"> values
  const damPositions: { pos: number; stationNo: string; name: string }[] = [];
  for (const m of html.matchAll(/stationNo','(\d+)'\)">([^<]+)<\/span>/g)) {
    damPositions.push({
      pos: m.index ?? 0,
      stationNo: m[1] ?? '',
      name: m[2]?.trim() ?? '',
    });
  }

  for (let i = 0; i < damPositions.length; i++) {
    const entry = damPositions[i];
    if (!entry) continue;
    const { pos, stationNo, name } = entry;
    const end = i + 1 < damPositions.length ? (damPositions[i + 1]?.pos ?? pos + 2000) : pos + 2000;
    const section = html.slice(pos, end);

    const vals = Array.from(section.matchAll(/<div class="dat2"[^>]*>([\s\S]*?)<\/div>/g)).map(
      (m) =>
        (m[1] ?? '')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim(),
    );

    if (vals.length < 5) continue;

    rows.push({
      miyagiName: name,
      stationNo,
      observedAt,
      waterLevelM: parseNum(vals[0] ?? ''),
      storageVolumeM3: (() => {
        const v = parseNum(vals[1] ?? '');
        return v !== null ? v * 1_000 : null;
      })(),
      inflowM3s: parseNum(vals[3] ?? ''),
      outflowM3s: parseNum(vals[4] ?? ''),
      storageRate: (() => {
        const r = parseNum(vals[8] ?? '');
        return r !== null ? r / 100 : null;
      })(),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '宮城県土木総合情報システム ダム現況表 — 21 ダム (18 県管理 + 3 国管理), hourly',
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
  miyagiName: string;
  damId: bigint;
}

/** Best master dam for a feed name; a row already stamped with the station wins. */
export function chooseMaster(
  miyagiName: string,
  masters: BindableMaster[],
  stationKey?: string,
): bigint | null {
  // A row already stamped with this station keeps it; names alone cannot
  // separate same-name dams (#57).
  const stamped = stationKey ? stampedMaster(masters, stationKey) : null;
  if (stamped) return stamped.id;
  const stem = normalizeName(miyagiName);
  if (!stem) return null;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === miyagiName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    if (!normalizeName(r.miyagiName)) continue;
    const damId = chooseMaster(r.miyagiName, masters, r.stationNo);

    universe.push({
      externalId: r.stationNo,
      name: r.miyagiName,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.miyagiName}"`);
      continue;
    }

    out.push({ miyagiName: r.miyagiName, damId });
    await bindExternalId(damId, SOURCE_ID, r.stationNo);
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

async function fetchTable(url: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) return null;
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

/**
 * The readings one run stores: the previous hour's table, then the latest.
 *
 * The table flips to the new hour as soon as the first stations report, and
 * most land well after that, so at the :06 cron the latest hour is mostly
 * blank rows — reading it alone never stored 岩堂沢 or 二ツ石 at all. The
 * previous hour is complete by then, so every station arrives an hour late at
 * worst; ON CONFLICT keeps the re-reads idempotent.
 *
 * Earlier rows must be strictly older than the latest table: were the server
 * ever to ignore the requested time, the same (dam, time) twice in one INSERT
 * would make ON CONFLICT reject the whole batch. A station still waiting on
 * its telemetry (no level, no volume) carries nothing to store.
 */
export function readingsToStore(latest: ParsedRow[], earlier: ParsedRow[]): ParsedRow[] {
  const latestMs = latest[0]?.observedAt.getTime() ?? Number.POSITIVE_INFINITY;
  return [...earlier.filter((p) => p.observedAt.getTime() < latestMs), ...latest].filter(
    (p) => p.waterLevelM !== null || p.storageVolumeM3 !== null,
  );
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const html = await fetchTable(DATA_URL);
  if (html === null) {
    log(`${SOURCE_ID}: latest table fetch failed; aborting`);
    return;
  }
  const rows = parseMiyagiTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const earlierUrl = earlierTableUrl(DATA_URL, html, 1);
  const earlierHtml = earlierUrl ? await fetchTable(earlierUrl) : null;
  if (!earlierHtml) log(`${SOURCE_ID}: previous-hour table unavailable`);
  const readings = readingsToStore(rows, earlierHtml ? parseMiyagiTable(earlierHtml) : []);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.miyagiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of readings) {
    const damId = damByName.get(p.miyagiName);
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
  log(
    `${SOURCE_ID} done: parsed=${rows.length} readings=${readings.length} matched=${matches.length} written=${written}`,
  );
};

export default task;
