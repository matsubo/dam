// apps/worker/src/tasks/ingest_shizuoka_bousai.ts
//
// 静岡県 河川・砂防情報システム ダム諸量現況表 — 県管理ダム hourly.
//
// Source:
//   https://kasen.pref.shizuoka.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus
//   ?sv=3&dk=4
//   (Shift_JIS HTML; standard 防災Web table; no session required)
//
// NOTE: This URL is accessible only from Japanese IP addresses. From outside
//   Japan the server returns a connection refused (HTTP 000). The adapter will
//   work normally from the production server in Japan.
//
// The 防災Web table format varies by prefecture configuration, so we use
// header-row detection to determine column positions at runtime. Known
// column header keywords:
//   dam name: 局名, ダム名, 地点名
//   timestamp: 最新観測時刻, 観測時刻
//   water level: 貯水位
//   storage volume: 有効貯水量, 貯水量
//   storage rate: 貯水率
//   inflow: 流入量, 全流入量
//   outflow: 放流量, 全放流量
//
// Priority 308. Cron hourly at :55 (spaced from other 防災Web sources).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.SHIZUOKA_BOUSAI_URL ??
  'https://kasen.pref.shizuoka.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4';

const PREF_CODE = '22';
const SOURCE_ID = 'shizuoka-bousai';

// --- types ------------------------------------------------------------------

export interface ColumnMap {
  damName: number;
  timestamp: number;
  waterLevel: number;
  storageVolume: number;
  storageRate: number;
  inflow: number;
  outflow: number;
}

export interface ParsedRow {
  damName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

// --- parsing ----------------------------------------------------------------

function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr|harr|larr|amp);/g, ' ')
    .replace(/[→↑↓←]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const clean = s.replace(/---+/g, '').trim();
  if (clean === '' || clean === '---') return null;
  const m = clean.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** Parse common 防災Web timestamp formats: "YYYY/MM/DD HH:MM" or "YYYY&nbsp;MM/DD&nbsp;HH:MM" JST */
export function parseBousaiTimestamp(s: string): Date | null {
  const clean = s.replace(/&nbsp;/g, ' ').trim();
  // "YYYY/MM/DD HH:MM" or "YYYY MM/DD HH:MM"
  const m = clean.match(/(\d{4})[/ ](\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Detect column positions from a 防災Web header row.
 * Returns a ColumnMap with -1 for columns that are not found.
 */
export function detectColumns(headers: string[]): ColumnMap {
  const cols: ColumnMap = {
    damName: -1,
    timestamp: -1,
    waterLevel: -1,
    storageVolume: -1,
    storageRate: -1,
    inflow: -1,
    outflow: -1,
  };

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i] ?? '';
    if (cols.damName < 0 && /局名|ダム名|地点名/.test(h)) cols.damName = i;
    if (cols.timestamp < 0 && /観測時刻/.test(h)) cols.timestamp = i;
    if (cols.waterLevel < 0 && /貯水位/.test(h)) cols.waterLevel = i;
    if (cols.storageVolume < 0 && /貯水量/.test(h) && !/貯水率/.test(h)) cols.storageVolume = i;
    if (cols.storageRate < 0 && /貯水率/.test(h)) cols.storageRate = i;
    if (cols.inflow < 0 && /流入量/.test(h)) cols.inflow = i;
    if (cols.outflow < 0 && /放流量/.test(h)) cols.outflow = i;
  }

  return cols;
}

/** Extract dam rows from a 防災Web Shift_JIS HTML table. */
export function parseBousaiWebTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];

  // Find all <table> blocks and look for the one with dam data
  const tableMatches = Array.from(html.matchAll(/<table[\s\S]*?<\/table>/gi));

  for (const tableMatch of tableMatches) {
    const tableHtml = tableMatch[0] ?? '';
    const trList = Array.from(tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
      Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map(
        (c) => c[1] ?? '',
      ),
    );

    if (trList.length < 2) continue;

    // Try to find a header row with column names
    let cols: ColumnMap | null = null;
    let dataStart = 0;

    for (let i = 0; i < Math.min(3, trList.length); i++) {
      const headerTexts = (trList[i] ?? []).map(cleanCell);
      const candidate = detectColumns(headerTexts);
      if (candidate.damName >= 0 && candidate.timestamp >= 0) {
        cols = candidate;
        dataStart = i + 1;
        break;
      }
    }

    if (!cols) continue;

    for (let i = dataStart; i < trList.length; i++) {
      const cells = trList[i] ?? [];
      if (cells.length < 5) continue;

      const rawName = cleanCell(cells[cols.damName] ?? '');
      if (!rawName) continue;

      // Extract dam name - may be wrapped in <a href>
      const nameMatch = (cells[cols.damName] ?? '').match(/<a[^>]+>([^<]+)<\/a>/);
      const damName = nameMatch ? (nameMatch[1] ?? '').trim() : rawName;

      if (!damName.includes('ダム') && !damName.includes('貯水池')) continue;

      const tsRaw = cleanCell(cells[cols.timestamp] ?? '');
      const observedAt = parseBousaiTimestamp(tsRaw);

      const waterLevelM =
        cols.waterLevel >= 0 ? parseNum(cleanCell(cells[cols.waterLevel] ?? '')) : null;

      const rawVol =
        cols.storageVolume >= 0 ? parseNum(cleanCell(cells[cols.storageVolume] ?? '')) : null;
      // 防災Web uses 10³m³ (千m³) for storage volume
      const storageVolumeM3 = rawVol !== null ? rawVol * 1_000 : null;

      const storageRate =
        cols.storageRate >= 0 ? parseNum(cleanCell(cells[cols.storageRate] ?? '')) : null;

      const inflowM3s = cols.inflow >= 0 ? parseNum(cleanCell(cells[cols.inflow] ?? '')) : null;

      const outflowM3s = cols.outflow >= 0 ? parseNum(cleanCell(cells[cols.outflow] ?? '')) : null;

      if (
        observedAt === null &&
        waterLevelM === null &&
        storageVolumeM3 === null &&
        storageRate === null
      )
        continue;

      rows.push({
        damName,
        observedAt,
        waterLevelM,
        storageVolumeM3,
        storageRate,
        inflowM3s,
        outflowM3s,
      });
    }

    if (rows.length > 0) break; // found the data table
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '静岡県河川・砂防情報システム ダム諸量現況表 — 防災Web HTML table, hourly',
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
  damName: string;
  damId: bigint;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.damName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === r.damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${r.damName}"`);
      continue;
    }
    out.push({ damName: r.damName, damId: best.id });
  }

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
  const rows = parseBousaiWebTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const damByName = new Map(matches.map((m) => [m.damName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.damName);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: missing timestamp for "${p.damName}"; skipping`);
      continue;
    }

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
