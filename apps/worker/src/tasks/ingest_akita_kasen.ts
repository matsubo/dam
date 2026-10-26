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
// "---" = the page's own blank (欠測/無効). 八郎潟防潮水門, a tide gate, is
// listed with the dams; it is recorded, never bound.
// No 貯水量 or 貯水率 columns (storage values set null).
// Priority 308, matching other 防災Web prefectural sources.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.AKITA_KASEN_URL ??
  'https://kasen.pref.akita.lg.jp/pc/servlet/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '05';
const SOURCE_ID = 'akita-kasen';

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

/** A value cell: "---" is the page's own mark. */
function valueCell(raw: string): Cell {
  const t = cleanCell(raw);
  return t === '---' ? MARKED : cell(parseNum(t), false);
}

/** "YYYY/MM/DD HH:MM" JST → UTC Date */
export function parseAkitaTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One station row's reading from its 最新観測時刻 and three dam columns. */
function rowReading(cells: string[]): Reading {
  const level = valueCell(cells[5] ?? '');
  const inflow = valueCell(cells[6] ?? '');
  const outflow = valueCell(cells[7] ?? '');
  const state = cellState([level, inflow, outflow]);
  if (state === 'empty') return { state, mark: '"---" in 貯水位, 流入量 and 放流量' };
  if (state === 'unreadable') return { state, why: 'no numeric dam value' };
  const ts = cleanCell(cells[4] ?? '');
  const observedAt = parseAkitaTimestamp(ts);
  if (!observedAt) return { state: 'unreadable', why: `最新観測時刻 "${ts}"` };
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * Every station row of the 防災Web table (12 <td> per row; the header rows
 * are <th>). Col [2] is the station name and the key.
 */
export function akitaEntries(html: string): Entry[] {
  const dataTable = html.match(/<table[\s\S]*?<\/table>/i)?.[0] ?? '';
  const entries: Entry[] = [];
  for (const tr of dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );
    if (cells.length < 8) continue;
    const name = cleanCell(cells[2] ?? '');
    if (!name) continue;
    entries.push({
      key: name,
      name,
      pref: PREF_CODE,
      // A row without ダム/貯水池 is not a dam (八郎潟防潮水門).
      ...(name.includes('ダム') || name.includes('貯水池') ? {} : { bind: 'never' as const }),
      reading: rowReading(cells),
    });
  }
  return entries;
}

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
  const entries = akitaEntries(html);
  log(`${SOURCE_ID}: ${entries.length} stations listed`);
  return { entries };
});
