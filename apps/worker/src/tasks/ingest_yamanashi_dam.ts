// apps/worker/src/tasks/ingest_yamanashi_dam.ts
//
// 山梨県雨量・水位情報 ダム状況表 — 6 県管理ダム hourly.
//
//   大門 / 塩川 / 広瀬 / 琴川 / 荒川 / 深城
//
// Source:
//   http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam005.asp?pAu=2
//
//   The 「ダム状況表」 tab of the ダム情報 frames (dam001.asp → dammain.asp
//   ?pFrm=3). One Shift_JIS page lists every dam; the server ignores the
//   P1..P5 query the site's own links carry and always serves the latest hour.
//   Header: "YYYY年MM月DD日 HH時MM分 現在" (JST; "24時00分" = next-day 00:00).
//   Table columns:
//     [0] ダム名
//     [1] 貯水位    [EL.m]
//     [2] 貯水量    [千 m3]
//     [3] 空容量    [千 m3]
//     [4] 全流入量  [m³/s]
//     [5] 全放流量  [m³/s]
//     [6] ダム雨量 時間 [mm/h]
//     [7] ダム雨量 累計 [mm]
//
//   No 貯水率 is published, so storage_rate stays NULL and the 0036 trigger
//   derives it from volume / active_capacity_m3. 貯水量 + 空容量 is the page's
//   implied denominator; on 2026-09-27 it equalled the master 有効貯水容量 for
//   塩川 8,900 / 広瀬 11,350 / 琴川 4,750 / 荒川 8,600 千m³ (大門 2,159 vs
//   2,350, 深城 5,337 vs 5,140). The derived rate is therefore 有効-based, the
//   static denominator, and this source is not trusted_rate_basis (0048).
//
// Priority 280. Cron hourly at :36.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const STATUS_URL =
  process.env.YAMANASHI_DAM_URL ??
  'http://www3.pref.yamanashi.jp/yamanashiweb/sub/dam/dam005.asp?pAu=2';

const PREF_CODE = '19';
const SOURCE_ID = 'yamanashi-dam';

// --- dam config (code → display name) --------------------------------------

// The site's station codes (P3). ダム状況表 rows carry only the name, and
// only these dams are ingested, as when each was fetched by code.
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
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * First "YYYY年MM月DD日 HH時MM分" (JST) in `s` → UTC.
 * "24時00分" on date D is treated as D+1 00:00 JST.
 */
export function parseYamanashiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})年(\d{2})月(\d{2})日\s*(\d{2})時(\d{2})分/);
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

/**
 * Every dam row of the ダム状況表 (dam005.asp), stamped with the page's "現在" time.
 * If the 貯水量 column stops saying [千 m3], volumes are dropped (and `warn` is
 * called) rather than stored at the wrong scale; the other fields are kept.
 */
export function parseYamanashiStatusHtml(html: string, warn: (s: string) => void): ParsedRow[] {
  const observedAt = parseYamanashiTimestamp(html);
  if (!observedAt) return [];
  const volumeInThousands = /貯水量\s*(?:<br>)?\s*\[千\s*m3\]/i.test(html);

  const rows: ParsedRow[] = [];
  for (const trMatch of html.matchAll(/<tr[^>]*>(.*?)<\/tr>/gis)) {
    const cells = [...(trMatch[1] ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gis)].map(
      (c) =>
        c[1]
          ?.replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .trim() ?? '',
    );
    // Data rows have 8 cells; the two header rows (rowspan / colspan) fewer.
    const name = cells[0];
    if (cells.length < 8 || !name) continue;

    const waterLevelM = parseNum(cells[1] ?? '');
    const volumeThousandM3 = volumeInThousands ? parseNum(cells[2] ?? '') : null;
    const inflowM3s = parseNum(cells[4] ?? '');
    const outflowM3s = parseNum(cells[5] ?? '');
    if (
      waterLevelM === null &&
      volumeThousandM3 === null &&
      inflowM3s === null &&
      outflowM3s === null
    ) {
      continue;
    }

    rows.push({
      yamanashiName: name,
      observedAt,
      waterLevelM,
      storageVolumeM3: volumeThousandM3 === null ? null : Math.round(volumeThousandM3 * 1000),
      inflowM3s,
      outflowM3s,
      rainfallMm: parseNum(cells[6] ?? ''),
    });
  }

  if (rows.length > 0 && !volumeInThousands) {
    warn(`${SOURCE_ID}: 貯水量 column is no longer labelled [千 m3]; volumes dropped`);
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 280,
            '山梨県雨量・水位情報 ダム状況表 — 6 県管理ダム (Shift_JIS HTML)',
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
export function chooseMaster(
  name: string,
  masters: BindableMaster[],
  stationKey?: string,
): bigint | null {
  // A row already stamped with this station keeps it; names alone cannot
  // separate same-name dams (#57).
  const stamped = stationKey ? stampedMaster(masters, stationKey) : null;
  if (stamped) return stamped.id;

  const stem = normalizeName(name);
  if (!stem) return null;

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
  return best?.m.id ?? null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  // What this source publishes, matched or not — taken from the dam catalogue
  // rather than this run's parsed rows, so a dam missing from the page still
  // counts as published instead of reading as 提供元なし. The station code is
  // the stamp, as it is the universe's external id.
  const universe: UniverseRow[] = [];
  for (const d of DAMS) {
    const damId = chooseMaster(d.name, masters, d.code);
    universe.push({
      externalId: d.code,
      name: d.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!rows.some((r) => r.yamanashiName === d.name)) continue;
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${d.name}"`);
      continue;
    }
    out.push({ yamanashiName: d.name, damId });
    await bindExternalId(damId, SOURCE_ID, d.code);
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

  let html: string | null = null;
  try {
    const r = await fetch(STATUS_URL, {
      headers: { 'user-agent': ua },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status === 200) html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
    else log(`${SOURCE_ID}: HTTP ${r.status}`);
  } catch (e) {
    // The universe is still recorded below, as it was when per-dam fetches failed.
    log(`${SOURCE_ID}: fetch failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rows: ParsedRow[] = [];
  for (const r of html === null
    ? []
    : parseYamanashiStatusHtml(html, (s) => helpers.logger.warn(s))) {
    if (DAMS.some((d) => d.name === r.yamanashiName)) rows.push(r);
    else log(`${SOURCE_ID}: "${r.yamanashiName}" is not in the dam catalogue; skipped`);
  }

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
      storageVolumeM3: p.storageVolumeM3,
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
