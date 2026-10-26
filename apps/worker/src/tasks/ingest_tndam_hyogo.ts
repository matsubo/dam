// apps/worker/src/tasks/ingest_tndam_hyogo.ts
//
// 兵庫県 丹波農林振興事務所 ダムテレメータ — 6 dams (Tanba area).
//
// Source:
//   http://tndam.pref.hyogo.lg.jp/dam/DamData.jsp?PSNO={1-6}
//   Shift_JIS HTML; single latest observation per dam (no time series).
//   更新時刻: JST timestamp. "0000/00/00 00:00:00" = dam offline: the
//   page's own mark, so provider-marked empty.
//
// Dams (PSNO → name):
//   1 鍔市ダム    2 八幡谷ダム  3 藤岡ダム
//   4 佐仲ダム    5 黒石ダム    6 大杉ダム
//   (PSNO=2,4 currently offline — timestamp "0000/00/00")
//
// Table: 貯水位(m), 貯水量(m³ — NOT 千m³), 貯水率(%), 流入量(m³/s),
//        越流量(ignored), 放流量(m³/s), 時間雨量(mm)
//
// Priority 308. Cron hourly at :53.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.TNDAM_HYOGO_URL ?? 'http://tndam.pref.hyogo.lg.jp/dam/DamData.jsp';
const PREF_CODE = '28';
const SOURCE_ID = 'tndam-hyogo';
const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

// The 6 DamData.jsp pages are the published catalogue; PSNO is the key.
const DAMS = [
  { psno: 1, name: '鍔市ダム' },
  { psno: 2, name: '八幡谷ダム' },
  { psno: 3, name: '藤岡ダム' },
  { psno: 4, name: '佐仲ダム' },
  { psno: 5, name: '黒石ダム' },
  { psno: 6, name: '大杉ダム' },
] as const;

// --- parsing -----------------------------------------------------------------

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNum(s: string): Cell {
  const trimmed = s.trim().replace(/[　\s]/g, '');
  if (trimmed === '-' || trimmed === '---') return MARKED;
  return trimmed ? cell(Number(trimmed), false) : null;
}

/**
 * Extract label→value pairs from bgcolor="#aaffaa" cells.
 * The page has alternating <td bgcolor="#aaffaa"> cells: label, value, label, value…
 * Labels contain superscript HTML (e.g. m<SUP>3</SUP>) which collapse to m3.
 */
export function extractDataMap(html: string): Map<string, string> {
  const cells: string[] = [];
  for (const m of html.matchAll(/<td[^>]*bgcolor="#aaffaa"[^>]*>([\s\S]*?)<\/td>/gi)) {
    cells.push(stripTags(m[1] ?? ''));
  }
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < cells.length; i += 2) {
    map.set(cells[i] ?? '', cells[i + 1] ?? '');
  }
  return map;
}

/**
 * Parse 「更新時刻：YYYY/MM/DD HH:MM:SS」 (JST) → UTC Date; 'offline' for
 * "0000/00/00 00:00:00", null when the page carries no 更新時刻.
 */
export function parseTndamTimestamp(html: string): Date | 'offline' | null {
  const m = html.match(/更新時刻[：:](\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const yr = +(m[1] ?? 0);
  if (yr === 0) return 'offline';
  const d = new Date(Date.UTC(yr, +(m[2] ?? 0) - 1, +(m[3] ?? 0), +(m[4] ?? 0) - 9, +(m[5] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** One dam page's reading. */
export function tndamReading(html: string): Reading {
  const observedAt = parseTndamTimestamp(html);
  if (observedAt === 'offline') return { state: 'empty', mark: '更新時刻 0000/00/00 (offline)' };
  const data = extractDataMap(html);

  const level = parseNum(data.get('貯水位(m)') ?? '');
  const volume = parseNum(data.get('貯水量(m3)') ?? '');
  const ratePct = parseNum(data.get('貯水率(%)') ?? '');
  const inflow = parseNum(data.get('流入量(m3/s)') ?? '');
  const outflow = parseNum(data.get('放流量(m3/s)') ?? '');
  const rain = parseNum(data.get('時間雨量(mm)') ?? '');

  const state = cellState([level, volume, ratePct, inflow, outflow, rain]);
  if (state === 'empty') return { state, mark: '- in every item' };
  if (state === 'unreadable') return { state, why: 'no readable value' };
  if (!observedAt) return { state: 'unreadable', why: 'no 更新時刻' };
  const rate = numberIn(ratePct);
  return {
    state,
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        storageVolumeM3: numberIn(volume),
        storageRate: rate !== null ? rate / 100 : null,
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        rainfallMm: numberIn(rain),
      },
    ],
  };
}

/** One DamData.jsp page by PSNO, decoded. Throws on an HTTP error. */
export type Fetcher = (psno: number) => Promise<string>;

/** All six pages, each read from its own page; one that fails is unreadable. */
export function tndamEntries(get: Fetcher): Entry[] {
  return DAMS.map(({ psno, name }) => ({
    key: String(psno),
    name,
    pref: PREF_CODE,
    reading: async () => tndamReading(await get(psno)),
  }));
}

// --- task --------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async () => ({
  entries: tndamEntries(async (psno) => {
    const resp = await fetch(`${BASE_URL}?PSNO=${psno}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (resp.status !== 200) throw new Error(`PSNO=${psno} HTTP ${resp.status}`);
    return new TextDecoder('shift_jis').decode(await resp.arrayBuffer());
  }),
}));
