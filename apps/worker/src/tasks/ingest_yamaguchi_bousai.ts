// apps/worker/src/tasks/ingest_yamaguchi_bousai.ts
//
// 山口県土木防災情報システム ダム観測局 — 23 ダム hourly.
//
//   小瀬川/生見川/御庄川/中山川/平瀬/今富/厚東川/真締川/末武川/木屋川/
//   向道/菅野/川上/屋代/佐波川/荒谷/一の坂/湯免/大坊/見島/阿武川/
//   黒杭川/黒杭川上流
//
// Source:
//   https://y-bousai.pref.yamaguchi.lg.jp/sp/dam/spdmObserve.aspx?stncd=NNN
//   One ASPX page per station (redirects to add current obsdt).
//   UTF-8 HTML; the データ table lists the last 24 hours at 10-minute steps,
//   oldest first. On-the-hour rows carry class "hour_HH", the others
//   "dotted minute_HH"; the window opens with a partial-hour row
//   (class "hour_HHb", e.g. 21:40). None of the data <tr>s is closed.
//
// Table columns per row:
//   col[0] 観測時刻 "YYYY/MM/DD<br />HH:MM" JST
//   col[1] 貯水位 [m]
//   col[2] 貯水率 [%]
//   col[3] 流入量 [m³/s]
//   col[4] 全放流量 [m³/s]
//   col[5] 調整流量 [m³/s] — skip
//   Missing values: "****" (欠測) or empty (未観測), per the site legend.
//   An outage can also print as 貯水位 0.00 with every other column 0.
//   No storageVolumeM3 available in this system.
//
// Every run writes all 24 hourly rows of the window, so an outage shorter
// than a day heals on the next successful run.
//
// Priority 308. Cron hourly at :46.

import { type BindableMaster, preferMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.YAMAGUCHI_BOUSAI_URL ??
  'https://y-bousai.pref.yamaguchi.lg.jp/sp/dam/spdmObserve.aspx';

const PREF_CODE = '35';
const SOURCE_ID = 'yamaguchi-bousai';

// Station map from sp/map/spWideMap.aspx (damCntHid=23)
const STATIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '001', name: '小瀬川ダム' },
  { code: '002', name: '生見川ダム' },
  { code: '003', name: '御庄川ダム' },
  { code: '004', name: '中山川ダム' },
  { code: '005', name: '黒杭川ダム' },
  { code: '006', name: '屋代ダム' },
  { code: '007', name: '向道ダム' },
  { code: '008', name: '菅野ダム' },
  { code: '009', name: '川上ダム' },
  { code: '010', name: '末武川ダム' },
  { code: '011', name: '佐波川ダム' },
  { code: '012', name: '荒谷ダム' },
  { code: '013', name: '一の坂ダム' },
  { code: '014', name: '今富ダム' },
  { code: '015', name: '厚東川ダム' },
  { code: '016', name: '真締川ダム' },
  { code: '017', name: '木屋川ダム' },
  { code: '018', name: '湯免ダム' },
  { code: '019', name: '大坊ダム' },
  { code: '020', name: '見島ダム' },
  { code: '021', name: '阿武川ダム' },
  { code: '022', name: '黒杭川上流ダム' },
  { code: '023', name: '平瀬ダム' },
];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  yamaguchiName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" (JST) → UTC. */
export function parseYamaguchiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseVal(s: string): number | null {
  const t = s.replace(/<[^>]+>/g, '').trim();
  if (!t || t === '-' || t === '---') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every on-the-hour row of a dam's 24-hour データ table, oldest first.
 *
 * The page never closes its data <tr>s, so a row runs up to the next <tr> or
 * the end of the table body. Matching up to </tr> instead swallowed the whole
 * table into its first row and stored the reading from 24 hours earlier.
 */
export function parseYamaguchiHtml(html: string, name: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const row of html.matchAll(
    /<tr\s+class="hour_\w+\s*">([\s\S]*?)(?=<tr[\s>]|<\/tbody>|<\/table>)/gi,
  )) {
    const cells = Array.from((row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );
    if (cells.length < 5) continue;

    // Timestamp cell: "YYYY/MM/DD<br />HH:MM" (also handles <br> and <br/>)
    const tsRaw = (cells[0] ?? '').replace(/<br\s*\/?>/gi, ' ').trim();
    const observedAt = parseYamaguchiTimestamp(tsRaw);
    // hour_HHb opens the window at HH:40 or so; only HH:00 is an hourly reading.
    if (observedAt?.getUTCMinutes() !== 0) continue;

    const waterLevelM = parseVal(cells[1] ?? '');
    // No reservoir here sits at EL 0 m (the lowest, 見島, holds ~19 m). The
    // page prints outages as 0.00 with every other column 0 (see 0086), so the
    // whole row is a placeholder.
    if (waterLevelM === 0) continue;
    const storageRatePct = parseVal(cells[2] ?? '');
    const storageRate = storageRatePct !== null ? storageRatePct / 100 : null;
    const inflowM3s = parseVal(cells[3] ?? '');
    const outflowM3s = parseVal(cells[4] ?? '');

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;

    out.push({ yamaguchiName: name, observedAt, waterLevelM, storageRate, inflowM3s, outflowM3s });
  }
  return out;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '山口県土木防災情報システム ダム観測局 — 23 ダム hourly HTML',
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
  yamaguchiName: string;
  damId: bigint;
}

/**
 * Best master dam for a station name, or null when nothing ranks. Equal ranks
 * go to preferMaster: 木屋川 has a （元） and a （再） row, and the （元） stays
 * the live structure until the （再） has a completion year (#79).
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
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

async function matchMaster(names: string[], log: (s: string) => void): Promise<DamMatch[]> {
  // Include Hiroshima (34) alongside Yamaguchi (35): 小瀬川ダム sits on the
  // prefectural boundary and is registered under pref_code='34' in the master.
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear"
    FROM dams WHERE pref_code = ANY(ARRAY['34', '35']) ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const name of names) {
    const damId = chooseMaster(name, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${name}"`);
      continue;
    }
    out.push({ yamaguchiName: name, damId });
  }

  // What this source publishes, matched or not — taken from the station
  // catalogue rather than this run's parsed rows, so a station whose page
  // failed to load still counts as published instead of reading as 提供元なし.
  const universe: UniverseRow[] = [];
  for (const s of STATIONS) {
    const damId = chooseMaster(s.name, masters);
    universe.push({
      externalId: s.code,
      name: s.name,
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

  // Fetch all stations in parallel
  const results = await Promise.allSettled(
    STATIONS.map(async ({ code, name }) => {
      const r = await fetch(`${BASE_URL}?stncd=${code}`, {
        headers: { 'user-agent': ua },
        signal: AbortSignal.timeout(20_000),
        redirect: 'follow',
      });
      if (r.status !== 200) {
        log(`${SOURCE_ID}: stncd=${code} HTTP ${r.status}`);
        return [];
      }
      const html = await r.text();
      return parseYamaguchiHtml(html, name);
    }),
  );

  const rows: ParsedRow[] = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const names = [...new Set(rows.map((r) => r.yamaguchiName))];

  log(`${SOURCE_ID}: parsed ${rows.length} hourly rows from ${names.length} dams`);

  const matches = await matchMaster(names, log);
  const damByName = new Map(matches.map((m) => [m.yamaguchiName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.yamaguchiName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
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
