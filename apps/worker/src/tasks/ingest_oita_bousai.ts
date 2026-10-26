// apps/worker/src/tasks/ingest_oita_bousai.ts
//
// 大分県河川情報 ダム諸量現況表 — 防災Web HTML table, hourly.
//
//   10 county-managed dams: 安岐(安岐川) / 行入(横手川) / 青江(青江川) /
//   野津(垣河内川) / 黒沢(堅田川) / 床木(床木川) /
//   稲葉(稲葉川) / 玉来(玉来川) / 芹川(芹川) / 北川(北川).
//
// Source:
//   https://river.pref.oita.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Format: Shift_JIS HTML table (no session required). 10 columns per row:
//   管理者名 | 河川名 | 局名(dam) | 所在地 | 最新観測時刻 |
//   貯水位[m] | 流入量[m³/s] | 貯水量[千m³] | 貯水率[%] | 放流量[m³/s]
// Timestamp: "YYYY MM/DD HH:MM" JST (with &nbsp; separators in raw HTML).
// Legend: *** 欠測, --- 無効. The table carries no station id, so the
// printed name is the key.
// Priority 308, matching other 防災Web prefectural sources.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.OITA_BOUSAI_URL ??
  'https://river.pref.oita.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '44';
const SOURCE_ID = 'oita-bousai';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  oitaName: string;
  riverName: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** Every value cell is the legend's *** (欠測) or --- (無効). */
  allMarked: boolean;
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

/** "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseOitaTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\s+(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract rows from the 防災Web table (10 columns per data row). */
export function parseOitaTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/gi);
  const dataTable = tableMatch?.[0] ?? '';

  const trList = Array.from(dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) => c[1] ?? ''),
  );

  for (const cells of trList) {
    if (cells.length < 10) continue;
    // Header rows share the <tr> shape; a dam row's 局名 names a ダム or 貯水池.
    const damName = cleanCell(cells[2] ?? '');
    if (!damName || (!damName.includes('ダム') && !damName.includes('貯水池'))) continue;

    const ts = cleanCell(cells[4] ?? '');
    const observedAt = parseOitaTimestamp(ts);

    const storageThou = parseNum(cleanCell(cells[7] ?? ''));

    rows.push({
      oitaName: damName,
      riverName: cleanCell(cells[1] ?? ''),
      observedAt,
      waterLevelM: parseNum(cleanCell(cells[5] ?? '')),
      inflowM3s: parseNum(cleanCell(cells[6] ?? '')),
      storageVolumeM3: storageThou !== null ? storageThou * 1_000 : null,
      storageRate: (() => {
        const r = parseNum(cleanCell(cells[8] ?? ''));
        return r !== null ? r / 100 : null;
      })(),
      outflowM3s: parseNum(cleanCell(cells[9] ?? '')),
      allMarked: cells.slice(5, 10).every((c) => /^(\*\*\*|---)$/.test(cleanCell(c))),
    });
  }

  return rows;
}

/** A row with a time and a 貯水位 or 貯水量 has values. */
export function oitaReading(p: ParsedRow): Reading {
  if (p.allMarked) return { state: 'empty', mark: '*** / --- in every value cell' };
  if (!p.observedAt) return { state: 'unreadable', why: 'no 最新観測時刻' };
  if (p.waterLevelM === null && p.storageVolumeM3 === null) {
    return { state: 'unreadable', why: 'no 貯水位 or 貯水量' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt: p.observedAt,
        storageVolumeM3: p.storageVolumeM3,
        storageRate: p.storageRate,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
        waterLevelM: p.waterLevelM,
      },
    ],
  };
}

/** Every dam row of the table. */
export function oitaEntries(rows: ParsedRow[]): Entry[] {
  return rows.map((p) => ({
    key: p.oitaName,
    name: p.oitaName,
    pref: PREF_CODE,
    // The table has printed 稲葉 as 稲葉貯水池; the master names it 稲葉.
    ...(p.oitaName.endsWith('貯水池') ? { bind: { name: p.oitaName.slice(0, -3) } } : {}),
    reading: oitaReading(p),
  }));
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status}`);

  const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  const rows = parseOitaTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  return { entries: oitaEntries(rows) };
});
