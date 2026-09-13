// apps/worker/src/tasks/ingest_ehime_bousai.ts
//
// 愛媛県 河川・砂防情報システム — ダム諸量経過表, 12 dams, hourly.
//
// Source:
//   http://183.176.244.72/kawabou-mng/customizeMyMenuKeika.do
//     ?GID=05-5101&userId=U1001&myMenuId=U1001_MMENU00X
//   (UTF-8 HTML; 24-hour hourly table per dam; publicly accessible)
//
// Dams (from MenuConfig.json grpid_value):
//   MMENU001 鹿森ダム    MMENU002 黒瀬ダム    MMENU003 玉川ダム
//   MMENU004 台ダム      MMENU005 須賀川ダム  MMENU006 山財ダム
//   MMENU007 柳瀬ダム(国) MMENU008 石手川ダム(国) MMENU009 鹿野川ダム(国)
//   MMENU010 野村ダム(国) MMENU011 新宮ダム(国)   MMENU012 富郷ダム(国)
//
// Table 1 (data) columns: [timestamp, waterLevel(m), inflow(m³/s),
//   outflow(m³/s), storage(1000m³), storageRate(%) ]
// Timestamp: first col is "MM/DD HH:MM" at date changes, "HH:MM" otherwise.
//   "24:00" = midnight of the NEXT calendar day.
// storageRate may be "-" for national dams → null.
//
// Priority 308. Cron hourly at :57.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.EHIME_BOUSAI_URL ??
  'http://183.176.244.72/kawabou-mng/customizeMyMenuKeika.do?GID=05-5101&userId=U1001';

const PREF_CODE = '38';
const SOURCE_ID = 'ehime-bousai';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

const DAMS = [
  { myMenuId: 'U1001_MMENU001', name: '鹿森ダム' },
  { myMenuId: 'U1001_MMENU002', name: '黒瀬ダム' },
  { myMenuId: 'U1001_MMENU003', name: '玉川ダム' },
  { myMenuId: 'U1001_MMENU004', name: '台ダム' },
  { myMenuId: 'U1001_MMENU005', name: '須賀川ダム' },
  { myMenuId: 'U1001_MMENU006', name: '山財ダム' },
  { myMenuId: 'U1001_MMENU007', name: '柳瀬ダム' },
  { myMenuId: 'U1001_MMENU008', name: '石手川ダム' },
  { myMenuId: 'U1001_MMENU009', name: '鹿野川ダム' },
  { myMenuId: 'U1001_MMENU010', name: '野村ダム' },
  { myMenuId: 'U1001_MMENU011', name: '新宮ダム' },
  { myMenuId: 'U1001_MMENU012', name: '富郷ダム' },
] as const;

// --- types -------------------------------------------------------------------

export interface EhimeReading {
  myMenuId: string;
  damName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing -----------------------------------------------------------------

function parseNum(s: string): number | null {
  if (!s || s === '-' || s === '---') return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function cleanText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTables(html: string): string[][][] {
  const tables: string[][][] = [];
  for (const tableM of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows: string[][] = [];
    for (const rowM of (tableM[1] ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = Array.from((rowM[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi), (c) =>
        cleanText(c[1] ?? ''),
      );
      rows.push(cells);
    }
    tables.push(rows);
  }
  return tables;
}

/**
 * Parse Ehime date-tracking timestamp.
 * Returns the observation Date (UTC) and the updated running date context.
 * Handles "MM/DD HH:MM" (full date), "HH:MM" (time only), and "24:00" (midnight+1).
 */
export function parseEhimeTimestamp(
  tsCell: string,
  ctx: { year: number; month: number; day: number },
): { date: Date | null; ctx: { year: number; month: number; day: number } } {
  // Full date: "MM/DD HH:MM"
  const fullM = tsCell.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (fullM) {
    const [, moS, dyS, hrS, miS] = fullM;
    const mo = +(moS ?? 0);
    const dy = +(dyS ?? 0);
    const hr = +(hrS ?? 0);
    const mi = +(miS ?? 0);
    const d = new Date(Date.UTC(ctx.year, mo - 1, dy, hr - 9, mi));
    return {
      date: Number.isNaN(d.getTime()) ? null : d,
      ctx: { year: ctx.year, month: mo, day: dy },
    };
  }

  // Time only: "HH:MM" or "24:00"
  const timeM = tsCell.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeM) return { date: null, ctx };

  const [, hrS, miS] = timeM;
  let hr = +(hrS ?? 0);
  const mi = +(miS ?? 0);
  let { year, month, day } = ctx;

  if (hr === 24) {
    // "24:00" = 00:00 of the next calendar day
    hr = 0;
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }

  const d = new Date(Date.UTC(year, month - 1, day, hr - 9, mi));
  return { date: Number.isNaN(d.getTime()) ? null : d, ctx: { year, month, day } };
}

/**
 * Parse an Ehime dam page HTML and return the latest (last) hourly reading.
 * Returns null if no data rows are found.
 */
export function parseEhimePage(
  html: string,
  myMenuId: string,
  expectedName: string,
  currentYear: number,
): EhimeReading | null {
  const tables = extractTables(html);
  // Table 0: meta (観測所名, 水系名, …)
  // Table 1: 24-row hourly data
  const dataRows = tables[1];
  if (!dataRows || dataRows.length === 0) return null;

  // Determine initial date context from today's JST
  // The 24-hour window starts ~24h before now, so use "yesterday" as fallback
  const nowUtc = Date.now();
  const jstMs = nowUtc + 9 * 3600 * 1000;
  const jst = new Date(jstMs);
  let ctx = {
    year: currentYear,
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
  };
  // Walk back 1 day to cover cases where rows begin the day before
  const yesterday = new Date(Date.UTC(ctx.year, ctx.month - 1, ctx.day - 1));
  ctx = {
    year: yesterday.getUTCFullYear(),
    month: yesterday.getUTCMonth() + 1,
    day: yesterday.getUTCDate(),
  };

  // Extract dam name from table 0 if available
  const damName = tables[0]?.[0]?.[1]?.replace(/[(（][^)）]*[)）]/g, '').trim() ?? expectedName;

  // Process all rows, tracking dates; keep the last complete one
  let lastReading: EhimeReading | null = null;

  for (const row of dataRows) {
    if (row.length < 5) continue;
    const tsCell = row[0] ?? '';
    const { date, ctx: newCtx } = parseEhimeTimestamp(tsCell, ctx);
    ctx = newCtx;
    if (!date) continue;

    const storageRatePct = parseNum(row[5] ?? '');
    lastReading = {
      myMenuId,
      damName,
      observedAt: date,
      waterLevelM: parseNum(row[1] ?? ''),
      inflowM3s: parseNum(row[2] ?? ''),
      outflowM3s: parseNum(row[3] ?? ''),
      storageVolumeM3: (() => {
        const v = parseNum(row[4] ?? '');
        return v !== null ? v * 1_000 : null;
      })(),
      storageRate: storageRatePct !== null ? storageRatePct / 100 : null,
    };
  }

  return lastReading;
}

// --- DB helpers --------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '愛媛県河川・砂防情報システム ダム諸量経過表 — 12 dams (6 pref + 6 national), hourly',
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
  myMenuId: string;
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
  readings: EhimeReading[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<
    { id: bigint; name: string; external_ids: Record<string, string> | null }[]
  >`
    SELECT id, name, external_ids FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of readings) {
    // Prefer external_id lookup
    const byExtId = masters.find((m) => m.external_ids?.[SOURCE_ID] === r.myMenuId);
    if (byExtId) {
      out.push({ myMenuId: r.myMenuId, damId: byExtId.id });
      continue;
    }

    const stem = normalizeName(r.damName);
    if (!stem) continue;
    const damId = chooseMaster(r.damName, stem, masters);

    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.damName}" (${r.myMenuId})`);
      continue;
    }

    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.myMenuId}::text)
      WHERE id = ${damId}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.myMenuId}
    `;
    out.push({ myMenuId: r.myMenuId, damId });
  }

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Built
  // from the DAMS catalogue rather than from `readings`: the 12 pages are
  // fetched through Promise.allSettled, so one timing out drops that dam from
  // readings entirely, and recording only what came back would eventually have
  // /coverage claim nobody publishes it.
  const matchedByMenuId = new Map(out.map((m) => [m.myMenuId, m.damId]));
  const universe: UniverseRow[] = DAMS.map(({ myMenuId, name }) => ({
    externalId: myMenuId,
    name,
    prefCode: PREF_CODE,
    // This run's match when the page came back; otherwise resolve the
    // catalogue name, and let recordUniverse's COALESCE keep an already
    // stored link if that finds nothing.
    resolvedDamId:
      matchedByMenuId.get(myMenuId) ?? chooseMaster(name, normalizeName(name), masters),
  }));
  await recordUniverse(SOURCE_ID, universe);

  return out;
}

// --- task --------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const currentYear = new Date().getUTCFullYear();
  const fetchHeaders = { 'user-agent': USER_AGENT };

  // Fetch all 12 dams concurrently
  const results = await Promise.allSettled(
    DAMS.map(async ({ myMenuId, name }) => {
      const url = `${BASE_URL}&myMenuId=${myMenuId}`;
      const resp = await fetch(url, {
        headers: fetchHeaders,
        signal: AbortSignal.timeout(20_000),
      });
      if (resp.status !== 200) {
        log(`${SOURCE_ID}: ${myMenuId} HTTP ${resp.status}`);
        return null;
      }
      const html = await resp.text();
      return parseEhimePage(html, myMenuId, name, currentYear);
    }),
  );

  const readings: EhimeReading[] = results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((r): r is EhimeReading => r !== null);

  log(`${SOURCE_ID}: fetched ${readings.length} readings`);

  const matches = await matchMaster(readings, log);
  const damByMenuId = new Map(matches.map((m) => [m.myMenuId, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const r of readings) {
    const damId = damByMenuId.get(r.myMenuId);
    if (!damId) continue;
    if (!r.observedAt) {
      log(`${SOURCE_ID}: missing observedAt for ${r.myMenuId}; skipping`);
      continue;
    }
    if (r.waterLevelM === null && r.storageVolumeM3 === null && r.storageRate === null) continue;

    inputs.push({
      observedAt: r.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: r.storageRate,
      inflowM3s: r.inflowM3s,
      outflowM3s: r.outflowM3s,
      waterLevelM: r.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${readings.length} matched=${matches.length} written=${written}`);
};

export default task;
