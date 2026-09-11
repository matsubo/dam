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
//   UTF-8 HTML; data in HTML table rows with class "hour_XX".
//
// Table columns per row:
//   col[0] 観測時刻 "YYYY/MM/DD<br />HH:MM" JST
//   col[1] 貯水位 [m]
//   col[2] 貯水率 [%]
//   col[3] 流入量 [m³/s]
//   col[4] 全放流量 [m³/s]
//   col[5] 調整流量 [m³/s] — skip
//   Missing values: "-" or empty.
//   No storageVolumeM3 available in this system.
//
// Priority 308. Cron hourly at :46.

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

/** Extract the most recent hourly row from a dam's ASPX page. */
export function parseYamaguchiHtml(html: string, name: string): ParsedRow | null {
  const hourRows = Array.from(html.matchAll(/<tr\s+class="hour_\w+\s*">([\s\S]*?)<\/tr>/gi));
  if (!hourRows.length) return null;

  // The table is sorted oldest → newest; take the last hourly row
  const lastRow = hourRows[hourRows.length - 1];
  if (!lastRow) return null;
  const cells = Array.from((lastRow[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
    (c) => c[1] ?? '',
  );
  if (cells.length < 5) return null;

  // Timestamp cell: "YYYY/MM/DD<br />HH:MM" (also handles <br> and <br/>)
  const tsRaw = (cells[0] ?? '').replace(/<br\s*\/?>/gi, ' ').trim();
  const observedAt = parseYamaguchiTimestamp(tsRaw);
  if (!observedAt) return null;

  const waterLevelM = parseVal(cells[1] ?? '');
  const storageRatePct = parseVal(cells[2] ?? '');
  const storageRate = storageRatePct !== null ? storageRatePct / 100 : null;
  const inflowM3s = parseVal(cells[3] ?? '');
  const outflowM3s = parseVal(cells[4] ?? '');

  if (waterLevelM === null && inflowM3s === null && outflowM3s === null) return null;

  return { yamaguchiName: name, observedAt, waterLevelM, storageRate, inflowM3s, outflowM3s };
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

/** Best master dam for a station name, or null when nothing ranks. */
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
  // Include Hiroshima (34) alongside Yamaguchi (35): 小瀬川ダム sits on the
  // prefectural boundary and is registered under pref_code='34' in the master.
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ANY(ARRAY['34', '35']) ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const damId = chooseMaster(r.yamaguchiName, masters);
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.yamaguchiName}"`);
      continue;
    }
    out.push({ yamaguchiName: r.yamaguchiName, damId });
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
        return null;
      }
      const html = await r.text();
      return parseYamaguchiHtml(html, name);
    }),
  );

  const rows: ParsedRow[] = results
    .filter((r): r is PromiseFulfilledResult<ParsedRow | null> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((v): v is ParsedRow => v !== null);

  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
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
