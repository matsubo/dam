// apps/worker/src/tasks/ingest_yamanashi_dam.ts
//
// 山梨県雨量・水位情報 時間ダム諸量表 — 6 県管理ダム hourly.
//
//   大門 / 塩川 / 広瀬 / 琴川 / 荒川 / 深城
//
// Source:
//   http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam004.asp
//   ?pFrm=2&pKbn=2&P1={YYYYMMDD HH:MM}&P2=6&P3={CODE}&P4=0&P5=0&pAu=2
//
//   Shift_JIS HTML; 6 separate requests (one per dam) run in parallel.
//   Table columns:
//     [0] 計測時刻  "YYYY/MM/DD HH:MM" or "YYYY/MM/DD 24:00" (JST)
//     [1] 時間雨量  [mm/h]
//     [2] 累計雨量  [mm]
//     [3] 貯水位    [EL.m]
//     [4] 流入量    [m³/s]
//     [5] 放流量    [m³/s]
//
//   "YYYY/MM/DD 24:00" = next-day 00:00 JST (common in Japanese dam systems).
//   No storage volume or storage rate available.
//
// Priority 280. Cron hourly at :36.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.YAMANASHI_DAM_URL ?? 'http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam004.asp';

const PREF_CODE = '19';
const SOURCE_ID = 'yamanashi-dam';

// --- dam config (code → display name) --------------------------------------

const DAMS: { code: string; name: string }[] = [
  { code: '5002', name: '大門ダム' },
  { code: '5001', name: '塩川ダム' },
  { code: '4001', name: '広瀬ダム' },
  { code: '4002', name: '琴川ダム' },
  { code: '1001', name: '荒川ダム' },
  { code: '8001', name: '深城ダム' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  yamanashiName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * "YYYY/MM/DD HH:MM" or "YYYY/MM/DD 24:00" (JST) → UTC.
 * "24:00" on date D is treated as D+1 00:00 JST.
 */
export function parseYamanashiTimestamp(s: string): Date | null {
  const m = s.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const utcH = hh === 24 ? -9 : hh - 9;
  const extraDay = hh === 24 ? 1 : 0;
  const d = new Date(Date.UTC(yr, mo - 1, dy + extraDay, utcH, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNum(s: string): number | null {
  const m = s.trim().match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Build URL for a single dam fetch. P1 is current JST time as-is; server ignores minutes. */
export function buildYamanashiUrl(code: string, nowUtc: Date, baseUrl: string): string {
  const jst = new Date(nowUtc.getTime() + 9 * 3_600_000);
  const y = jst.getUTCFullYear();
  const mo = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(jst.getUTCDate()).padStart(2, '0');
  const hh = String(jst.getUTCHours()).padStart(2, '0');
  const p1 = encodeURIComponent(`${y}/${mo}/${dy} ${hh}:00`);
  return `${baseUrl}?pFrm=2&pKbn=2&P1=${p1}&P2=6&P3=${code}&P4=0&P5=0&pAu=2`;
}

/** Parse the first (latest) data row from the dam004.asp HTML. */
export function parseYamanashiHtml(html: string, yamanashiName: string): ParsedRow | null {
  for (const trMatch of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    const cells = [...(trMatch[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(
      (c) =>
        c[1]
          ?.replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim() ?? '',
    );
    if (cells.length < 6) continue;
    if (!/^\d{4}\/\d{2}\/\d{2}/.test(cells[0] ?? '')) continue;

    const observedAt = parseYamanashiTimestamp(cells[0] ?? '');
    if (!observedAt) continue;

    const rainfallMm = parseNum(cells[1] ?? '');
    const waterLevelM = parseNum(cells[3] ?? '');
    const inflowM3s = parseNum(cells[4] ?? '');
    const outflowM3s = parseNum(cells[5] ?? '');

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) return null;

    return { yamanashiName, observedAt, waterLevelM, inflowM3s, outflowM3s, rainfallMm };
  }
  return null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 280,
            '山梨県雨量・水位情報 時間ダム諸量表 — 6 県管理ダム (Shift_JIS HTML)',
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
  yamanashiName: string;
  damId: bigint;
}

/** Best master dam for a dam name, or null when nothing ranks. */
function chooseMaster(name: string, masters: { id: bigint; name: string }[]): bigint | null {
  const stem = normalizeName(name);
  if (!stem) return null;

  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === name) rank = 0;
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

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const damId = chooseMaster(r.yamanashiName, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.yamanashiName}"`);
      continue;
    }
    out.push({ yamanashiName: r.yamanashiName, damId });
  }

  // What this source publishes, matched or not — taken from the dam catalogue
  // rather than this run's parsed rows, so a dam whose page failed to load
  // still counts as published instead of reading as 提供元なし.
  const universe: UniverseRow[] = [];
  for (const d of DAMS) {
    const damId = chooseMaster(d.name, masters);
    universe.push({
      externalId: d.code,
      name: d.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
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

  const now = new Date();

  // Fetch all 6 dams in parallel
  const results = await Promise.allSettled(
    DAMS.map(async ({ code, name }) => {
      const url = buildYamanashiUrl(code, now, BASE_URL);
      const r = await fetch(url, {
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status !== 200) {
        log(`${SOURCE_ID}: HTTP ${r.status} for ${name}`);
        return null;
      }
      const buf = await r.arrayBuffer();
      const html = new TextDecoder('shift_jis').decode(buf);
      return parseYamanashiHtml(html, name);
    }),
  );

  const rows: ParsedRow[] = results
    .filter((r): r is PromiseFulfilledResult<ParsedRow | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is ParsedRow => v !== null);

  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.yamanashiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.yamanashiName);
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
      rainfallMm: p.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
