// apps/worker/src/tasks/ingest_tottori.ts
//
// Seventh real-observation source. 鳥取県ダム諸量情報システム publishes every
// dam's latest values in 10分データ全ダム一覧 (`/{dam}/data10all.php`), refreshed
// every 10 minutes server-side. Five prefectural dams covered:
//
//   賀祥 (kasho), 朝鍋 (asanabe), 佐治川 (sajigawa),
//   東郷 (togo),  百谷 (momodani).
//
// Page is EUC-JP encoded; we decode via TextDecoder. One row per dam:
//
//   佐治川ダム | 時間雨量 0 | 累計雨量 0 | ダム水位 382.57 | 流入量 1.04 |
//   放流量 0.12 | 有効貯水量 111 | 有効貯水容量 1880 | 貯水率 6 | 空容量 1663 | …
//
// 貯水率 is 有効貯水容量-based — 朝鍋ダムの諸量ページ states 「貯水率＝有効貯水量
// ／有効貯水容量」 — and the denominator is printed on the row, so each rate can
// be checked against its own volume.
//
// The top page's <area alt> blocks carried the same fields and were the original
// source, but 賀祥ダム's block disagrees with the rest of the site: at
// 2026/09/11 05:30 it read 有効貯水量 452 千m³ / 貯水率 07 % while this table, the
// dam's own 諸量ページ and 鳥取県防災Web all read 1,212 千m³ / 18 % for the same
// water level. Only 賀祥 is affected; the other four agree exactly.
//
// Cron: hourly at :09.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const SOURCE_ID = 'tottori-dam';

// 10分データ全ダム一覧 — one request for all five dams. Only served from inside
// a dam directory; every copy renders the same table.
const PAGE_URL = process.env.TOTTORI_DAM_URL ?? 'http://tottoridam.jp/kasho/data10all.php';

/** The five dams the table lists, known in advance (the universe if the page fails). */
const DAMS = ['賀祥ダム', '朝鍋ダム', '佐治川ダム', '東郷ダム', '百谷ダム'] as const;

const PREF_CODE = '31';

export interface ParsedRow {
  name: string;
  observedAt: Date;
  waterLevelM: Cell;
  inflowM3s: Cell;
  outflowM3s: Cell;
  storageVolumeM3: Cell;
  /** 有効貯水容量 the row's own 貯水率 is divided by (千m³ → m³). */
  effectiveCapacityM3: number | null;
  storageRate: Cell;
  rainfallMm: Cell;
}

/** The site's own no-value marks. */
const MARKS = new Set(['―', '-', '欠測']);

function field(s: string): Cell {
  const t = s.replace(/[,\s　]/g, '');
  if (MARKS.has(t)) return MARKED;
  return t ? cell(Number(t), false) : null;
}

/** Parse 「2026/05/15 22:50」 (or 「2026/5/15 23:00」 — Tottori uses both)
 *  as JST → UTC. */
function parseJstStamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** Strip tags and entities from one table cell. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[　]/g, ' ')
    .trim();
}

/**
 * How far a published 貯水率 may sit from 有効貯水量 / 有効貯水容量 and still be
 * kept. The site prints whole percents, so rounding alone is worth half a point;
 * every row on 2026-09-11 09:20 landed within 0.5 points of its own ratio.
 */
const RATE_TOLERANCE = 0.05;

/**
 * Parse 10分データ全ダム一覧 (`/{dam}/data10all.php`) — every dam in one table,
 * with the 有効貯水容量 each 貯水率 is divided by printed on the same row.
 * Null when the page is not the table (maintenance page, no timestamp).
 *
 * Columns are located by their header label rather than by position so a new
 * 下流水位 column cannot silently shift the values.
 */
export function parseTottoriAllPage(html: string): ParsedRow[] | null {
  const table = /<table[^>]*class="data10"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (!table) return null;

  const stamp = /<p[^>]*id="date"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? '';
  const observedAt = parseJstStamp(stamp);
  if (!observedAt) return null;

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? '');
  const header = rows.find((r) => r.includes('<th'));
  if (!header) return null;
  // Header labels line up with the data cells one-for-one, the leading blank
  // cell included, so their index is the data cell's index.
  const labels = [...header.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
    cellText(m[1] ?? ''),
  );
  const indexOf = (label: string): number => labels.findIndex((l) => l.startsWith(label));

  const idx = {
    rainfall: indexOf('時間雨量'),
    level: indexOf('ダム水位'),
    inflow: indexOf('流入量'),
    outflow: indexOf('放流量'),
    volume: indexOf('有効貯水量'),
    capacity: indexOf('有効貯水容量'),
    rate: indexOf('貯水率'),
  };

  const out: ParsedRow[] = [];
  for (const row of rows) {
    if (row.includes('<th')) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1] ?? ''));
    const name = cells[0] ?? '';
    if (!name) continue;

    const at = (i: number): Cell => (i < 0 ? null : field(cells[i] ?? ''));
    const volume = at(idx.volume);
    const volThou = numberIn(volume);
    const capThou = numberIn(at(idx.capacity));
    const rateCell = at(idx.rate);
    const ratePct = numberIn(rateCell);

    // 鳥取県 publishes 貯水率 = 有効貯水量 / 有効貯水容量 (stated on the 朝鍋 page),
    // so every row carries its own check: keep a rate only while it still matches
    // the volume and capacity printed beside it. Note this would NOT have caught
    // the top page's 賀祥 block — 452 千m³ against 6,690 is 6.8 %, and it published
    // 07 % — because volume and rate were wrong together. That one only showed up
    // against 空容量 (452 + 5,478 ≠ 6,690), which is not a usable invariant here:
    // 東郷 misses it by 6 % on a good row (204 + 485 vs 650).
    const rate = ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null;
    const implied = volThou != null && capThou ? volThou / capThou : null;
    const consistent =
      rate == null || implied == null || Math.abs(implied - rate) <= RATE_TOLERANCE;

    out.push({
      name,
      observedAt,
      waterLevelM: at(idx.level),
      inflowM3s: at(idx.inflow),
      outflowM3s: at(idx.outflow),
      storageVolumeM3: volThou != null ? volThou * 1_000 : volume,
      effectiveCapacityM3: capThou != null ? capThou * 1_000 : null,
      // A contradicted rate is known-bad: unread, not the provider's mark.
      storageRate: rate == null ? rateCell : consistent ? rate : null,
      rainfallMm: at(idx.rainfall),
    });
  }
  return out;
}

export function tottoriReading(row: ParsedRow): Reading {
  const cells: Cell[] = [
    row.waterLevelM,
    row.inflowM3s,
    row.outflowM3s,
    row.storageVolumeM3,
    row.storageRate,
    row.rainfallMm,
  ];
  const state = cellState(cells);
  if (state === 'empty') return { state, mark: '欠測/― in every column' };
  if (state === 'unreadable') return { state, why: 'no readable value in the row' };
  return {
    state,
    observations: [
      {
        observedAt: row.observedAt,
        waterLevelM: numberIn(row.waterLevelM),
        inflowM3s: numberIn(row.inflowM3s),
        outflowM3s: numberIn(row.outflowM3s),
        storageVolumeM3: numberIn(row.storageVolumeM3),
        storageRate: numberIn(row.storageRate),
        rainfallMm: numberIn(row.rainfallMm),
      },
    ],
  };
}

function entry(name: string, reading: Reading): Entry {
  return { key: name, name, pref: PREF_CODE, reading };
}

/** Every row of the table; a known dam the page lacks, or every dam on a broken page, is unreadable. */
export function tottoriEntries(html: string): Entry[] {
  const rows = parseTottoriAllPage(html);
  if (!rows) return DAMS.map((n) => entry(n, { state: 'unreadable', why: 'no data10 table' }));
  const entries = rows.map((r) => entry(r.name, tottoriReading(r)));
  for (const n of DAMS) {
    if (!rows.some((r) => r.name === n)) {
      entries.push(entry(n, { state: 'unreadable', why: 'not in the table' }));
    }
  }
  return entries;
}

async function fetchPage(): Promise<string> {
  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  // Page is EUC-JP — decode explicitly.
  return new TextDecoder('euc-jp').decode(await r.arrayBuffer());
}

export default ingestTask(SOURCE_ID, async (log) => {
  let html: string;
  try {
    html = await fetchPage();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: DAMS.map((n) => entry(n, { state: 'unreadable', why })) };
  }
  return { entries: tottoriEntries(html) };
});
