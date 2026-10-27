// apps/worker/src/tasks/ingest_ibaraki_bousai.ts
//
// 茨城県河川防災情報 ダム諸量現況表 — 防災Web HTML table, hourly.
//
//   7 county-managed dams: 小山(大北川) / 飯田(飯田川) / 藤井川 /
//   竜神(竜神川) / 十王(十王川) / 花貫(花貫川) / 花園(花園川).
//
// Source:
//   http://www.kasen.pref.ibaraki.jp/pc/sv/bousaiTableStatus.html?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Format: Shift_JIS HTML table (no session required). 9 columns per row:
//   管理者 | 河川名 | 局名(dam) | 所在地 | 最新観測時刻 |
//   貯水位[m] | 貯水量[10³m³] | 流入量[m³/s] | 全放流量[m³/s]
// Timestamp: "YYYY MM/DD HH:MM" JST.
// "---" = the page's own blank (欠測/無効).
// No 貯水率 column (storage rate set null).
// Priority 308, matching other 防災Web prefectural sources.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL =
  process.env.IBARAKI_BOUSAI_URL ??
  'http://www.kasen.pref.ibaraki.jp/pc/sv/bousaiTableStatus.html?sv=3&dk=4&mp=0&no=0&fn=0&pg=1';

const PREF_CODE = '08';
const SOURCE_ID = 'ibaraki-bousai';

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

/** A value cell: "---" is the page's own mark. */
function valueCell(raw: string): Cell {
  const t = cleanCell(raw);
  if (t === '---') return MARKED;
  const m = t.match(/-?\d+(?:\.\d+)?/);
  return cell(m ? Number(m[0]) : null, false);
}

/** "YYYY MM/DD HH:MM" or "YYYY MM/DD HH:MM" JST → UTC Date */
export function parseIbarakiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\s+(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hr, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One station row's reading from its 最新観測時刻 and four dam columns. */
function rowReading(cells: string[]): Reading {
  const level = valueCell(cells[5] ?? '');
  const storageThou = valueCell(cells[6] ?? '');
  const inflow = valueCell(cells[7] ?? '');
  const outflow = valueCell(cells[8] ?? '');
  const state = cellState([level, storageThou, inflow, outflow]);
  if (state === 'empty') return { state, mark: '"---" in every dam column' };
  if (state === 'unreadable') return { state, why: 'no numeric dam value' };
  const ts = cleanCell(cells[4] ?? '');
  const observedAt = parseIbarakiTimestamp(ts);
  if (!observedAt) return { state: 'unreadable', why: `最新観測時刻 "${ts}"` };
  const thou = numberIn(storageThou);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: thou !== null ? thou * 1_000 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
      },
    ],
  };
}

/**
 * Every station row of the 防災Web table (the second <table>; 9 <td> per
 * data row). Col [2] is the 局名 and the key.
 */
export function ibarakiEntries(html: string): Entry[] {
  const dataTable = html.match(/<table[\s\S]*?<\/table>/gi)?.[1] ?? '';
  const entries: Entry[] = [];
  for (const tr of dataTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from((tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );
    if (cells.length < 9) continue;
    // Header rows are <th>; a unit row has no 局名.
    const name = cleanCell(cells[2] ?? '');
    if (!name) continue;
    entries.push({
      key: name,
      name,
      pref: PREF_CODE,
      // A row without ダム/貯水池 is not a dam.
      ...(name.includes('ダム') || name.includes('貯水池') ? {} : { bind: 'never' as const }),
      reading: rowReading(cells),
    });
  }
  return entries;
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(DATA_URL)).text('shift_jis');
  const entries = ibarakiEntries(html);
  log(`${SOURCE_ID}: ${entries.length} stations listed`);
  return { entries };
});
