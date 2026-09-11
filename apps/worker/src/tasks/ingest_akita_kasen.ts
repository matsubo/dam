// apps/worker/src/tasks/ingest_akita_kasen.ts
//
// 秋田県河川砂防情報システム ダム一覧表 — 防災Web HTML table, hourly.
//
//   18 県管理ダム: 砂子沢/萩形/森吉/早口/山瀬/素波里/水沢/旭川/岩見/
//   大内/鎧畑/協和/大松川/皆瀬/板戸/森吉山/玉川. (八郎潟防潮水門 は除外)
//
// Source:
//   https://kasen.pref.akita.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus
//   ?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Format: Shift_JIS HTML table (no session required). 12 columns per data row:
//   管轄 | 河川名 | 局名(dam) | 所在地 | 最新観測時刻 |
//   貯水位[EL.m] | 流入量[m³/s] | 放流量[m³/s] |
//   上流水位[m] | 下流水位[m] | 時間雨量[mm] | 累加雨量[mm]
// Timestamp: "YYYY/MM/DD HH:MM" JST (after &nbsp; cleanup).
// No 貯水量 or 貯水率 columns (storage values set null).
// Priority 308, matching other 防災Web prefectural sources.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.AKITA_KASEN_URL ??
  'https://kasen.pref.akita.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '05';
const SOURCE_ID = 'akita-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  akitaName: string;
  riverName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseAkitaTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Extract dam rows from the 防災Web table (12 columns per data row).
 * Col [2] contains the dam name; rows without "ダム"/"貯水池" are skipped.
 */
export function parseAkitaTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/gi);
  const dataTable = tableMatch?.[0] ?? '';

  const trList = Array.from(dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) => c[1] ?? ''),
  );

  for (const cells of trList) {
    if (cells.length < 8) continue;
    const damName = cleanCell(cells[2] ?? '');
    if (!damName || (!damName.includes('ダム') && !damName.includes('貯水池'))) continue;

    const ts = cleanCell(cells[4] ?? '');
    const observedAt = parseAkitaTimestamp(ts);

    rows.push({
      akitaName: damName,
      riverName: cleanCell(cells[1] ?? ''),
      observedAt,
      waterLevelM: parseNum(cleanCell(cells[5] ?? '')),
      inflowM3s: parseNum(cleanCell(cells[6] ?? '')),
      outflowM3s: parseNum(cleanCell(cells[7] ?? '')),
    });
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '秋田県ダム一覧表 — 防災Web HTML table, 18 dams, hourly',
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
  akitaName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. Keyed by
  // name so a table that repeats one twice can't break the upsert.
  const universe = new Map<string, UniverseRow>();

  for (const r of rows) {
    const stem = normalizeName(r.akitaName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (mStem === stem) rank = 0;
      else if (m.name === `${stem}ダム`) rank = 1;
      else if (mStem.startsWith(stem)) rank = 2;
      else if (mStem.includes(stem)) rank = 3;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    universe.set(r.akitaName, {
      externalId: r.akitaName,
      name: r.akitaName,
      prefCode: PREF_CODE,
      resolvedDamId: best?.id ?? null,
    });

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.akitaName}"`);
      continue;
    }

    out.push({ akitaName: r.akitaName, damId: best.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object(${SOURCE_ID}::text, ${r.akitaName}::text)
      WHERE id = ${best.id}
        AND COALESCE(external_ids->>${SOURCE_ID}, '') <> ${r.akitaName}
    `;
  }

  await recordUniverse(SOURCE_ID, [...universe.values()]);
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
  const rows = parseAkitaTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.akitaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.akitaName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.akitaName}"; skipping`);
      continue;
    }
    if (p.waterLevelM === null) continue;

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
