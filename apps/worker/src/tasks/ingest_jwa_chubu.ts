// apps/worker/src/tasks/ingest_jwa_chubu.ts
//
// 水資源機構 中部支社 — 6 dams from the daily water-source status report:
//
//   木曽川水系: 牧尾/阿木川/味噌川/岩屋/徳山
//   三重用水:   中里 (いなべ市, 三重 — not a 長野 dam; see migration 0083)
//
// Source: https://www.water.go.jp/mizu/chubu/report/
// Format: Static HTML; date "YYYY年MM月DD日"; storage units 千m³. Each dam is a
//         block headed by <span class="dam-name">; values sit in
//         <div class="databox">: [EL …] = 0時の貯水位, 流入量/放流量 = 前日平均,
//         貯水量<br>&lt;午前0時&gt; and (貯水率 …) on the 利水容量 basis; only the
//         有効 part of that is stored (see storedStorage).
// License: 水資源機構「著作権・リンク等について」(honsya/honsya/policy/copyright):
//         「数値データ、簡単な表・グラフ等は著作権の対象ではありませんので、これらに
//         ついては本利用ルールの適用はなく、自由に利用できます。」 The report is
//         served by the 中部支社 リアルタイム情報 system, whose note
//         (mizu/chubu/res/description/description.pdf) asks: 「ツール等による、
//         自動的なデータ収集等はサーバに負荷がかかり、情報提供できなくなる恐れが
//         ありますのでご遠慮頂くよう、ご理解・ご協力をお願いいたします。」 Kept on
//         that basis (user decision, 2026-09-28): only the observed numbers are
//         stored, with the source named. The report comes out once per weekday
//         (09:40–11:40 JST), so the cron fetches this one page three times per
//         weekday, not hourly.
//
// New coverage: 中里ダム (not in jwa-junpo).
// Overlap (牧尾/阿木川/味噌川/岩屋/徳山): provides inflow/outflow and daily
// cadence vs jwa-junpo's 10-day. aitoyo has same 5 overlap dams at priority 295,
// so jwa-chubu (296) becomes preferredSource for them when both present.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.JWA_CHUBU_URL ?? 'https://www.water.go.jp/mizu/chubu/report/';
const SOURCE_ID = 'jwa-chubu';

/** The six dams jwa-chubu stores, by printed name (also the stamp and universe key). */
const DAMS: Record<string, string> = {
  牧尾ダム: '20', // 長野
  阿木川ダム: '21', // 岐阜
  味噌川ダム: '20',
  岩屋ダム: '21',
  中里ダム: '24', // 三重 (三重用水)
  徳山ダム: '21',
};

/**
 * The page's other rows: recorded, never written. 宇連/大島 belong to 豊川用水,
 * which aitoyo and jwa-toyokawa carry; the rest are pond groups and a
 * conduit, not one dam.
 */
const OTHER_ROWS: Record<string, Pick<Entry, 'pref' | 'bind' | 'dontWrite'>> = {
  宇連ダム: { pref: '23', dontWrite: 'not one of jwa-chubu’s six dams (豊川用水)' },
  大島ダム: { pref: '23', dontWrite: 'not one of jwa-chubu’s six dams (豊川用水)' },
  地区内調整池: { pref: '23', bind: 'never' },
  長良導水: { pref: null, bind: 'never' },
  '調整池(宮川・菰野・加佐登)': { pref: '24', bind: 'never' },
};

/**
 * A 「(…合計)」 row sums the rows listed under it (豊川用水 37,476 = 宇連
 * 18,293 + 大島 7,558 + 地区内調整池 11,625; 三重用水 6,429 = 中里 1,760 +
 * 調整池 4,669 千m³), so it is not an entry of its own.
 */
const TOTAL_ROW = /合計\)$/;

export interface ParsedRow {
  /** The row's printed name: its dam-name spans joined ("三重用水(中里ダム・調整池合計)"). */
  name: string;
  /** Label of the capacity printed under the name: 利水容量 or 有効貯水量 (徳山). */
  capacityBasis: '利水' | '有効' | null;
  capacityThouM3: number | null;
  /** 貯水量 at 午前0時 — storage within `capacityBasis`, not necessarily 有効. */
  storageVolumeThouM3: number | null;
  storageRatePct: number | null;
  /** The current 有効貯水量 a few blocks print below the 利水 figures (阿木川, 味噌川). */
  effectiveVolumeThouM3: number | null;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s　%千m³/s]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Parse "YYYY年MM月DD日" → JST midnight = UTC day-1 15:00. */
export function parseChubuDate(text: string): Date | null {
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!yr || !mo || !day) return null;
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The first <div class="databox"> value after `marker`. */
function databoxAfter(block: string, marker: RegExp): number | null {
  const m = marker.exec(block);
  if (!m) return null;
  const box = block.slice(m.index + m[0].length).match(/<div class="databox[^"]*">([^<]*)<\/div>/);
  return box ? parseNum(box[1] ?? '') : null;
}

function parseBlock(name: string, block: string): ParsedRow {
  const capacity = /^(?:\s|<br\s*>)*(利水容量|有効貯水量)<br>/.exec(block);
  const rateAt = block.indexOf('貯水率');
  return {
    name,
    capacityBasis: capacity ? (capacity[1] === '利水容量' ? '利水' : '有効') : null,
    capacityThouM3: capacity ? databoxAfter(block, /^/) : null,
    // 貯水量<br>&lt;午前0時&gt; is the storage; the 有効貯水量<br> label above
    // it (徳山) is the capacity, and 前日貯水量との増減 the day's change.
    storageVolumeThouM3: databoxAfter(block, /(?<!有効)貯水量<br>/),
    storageRatePct: databoxAfter(block, /貯水率(?=<div)/),
    effectiveVolumeThouM3: rateAt < 0 ? null : databoxAfter(block.slice(rateAt), /有効貯水量<br>/),
    waterLevelM: databoxAfter(block, /\[EL\s*/),
    inflowM3s: databoxAfter(block, /流入量(?=<div)/),
    outflowM3s: databoxAfter(block, /(?<!利水)放流量(?=<div)/),
  };
}

/**
 * Every row of the report, in page order. A row is headed by one or more
 * <span class="dam-name…"> (a group name and its 合計 note, "調整池" and its
 * ponds) and runs to the next heading or the end of its table. Matching
 * whole spans keeps 中里ダム off 「(中里ダム・調整池合計)」, the 三重用水 total
 * printed first.
 */
export function parseChubuHtml(html: string): { reportDate: Date | null; rows: ParsedRow[] } {
  const reportDate = parseChubuDate(html);
  const heads = [...html.matchAll(/<span class="dam-name[^"]*">([^<]*)<\/span>/g)];
  const rows: ParsedRow[] = [];
  let name = '';
  heads.forEach((head, i) => {
    name += (head[1] ?? '').trim();
    const from = head.index + head[0].length;
    const rest = html.slice(from, heads[i + 1]?.index ?? html.length);
    const end = rest.indexOf('</table>');
    const block = end < 0 ? rest : rest.slice(0, end);
    // A heading followed straight by another names the same row.
    if (/^(?:\s|<br\s*\/?>)*$/.test(block) && heads[i + 1]) return;
    rows.push(parseBlock(name, block));
    name = '';
  });
  return { reportDate, rows };
}

/**
 * What of a parsed row may be stored. jwa-chubu is not trusted_rate_basis, so
 * the site divides every stored volume by the master's 有効 capacity: only
 * 有効 storage may go in, and a published rate only where its denominator is
 * that same capacity.
 *
 * - 利水容量 equal to the master's 有効 (牧尾, 中里): 貯水量 and 貯水率 both are.
 * - A printed current 有効貯水量 (阿木川, 味噌川): store it; the 利水 rate is not
 *   有効-based, so the 0036 trigger derives one instead.
 * - Labelled 有効貯水量 (徳山): 貯水量 is 有効 storage, but the rate divides by a
 *   seasonal pool (257,400 / 366,400 千m³ per the page footer), not the master.
 * - Otherwise (岩屋: 利水 61,900 of a 150,000 千m³ pool) nothing is 有効.
 */
function storedStorage(
  row: ParsedRow & { storageVolumeThouM3: number; storageRatePct: number },
  masterActiveM3: number | null,
): { storageVolumeM3: number | null; storageRate: number | null } {
  const pool = row.capacityThouM3 === null ? null : row.capacityThouM3 * 1_000;
  if (
    masterActiveM3 !== null &&
    pool !== null &&
    Math.abs(pool - masterActiveM3) <= masterActiveM3 * 0.005
  ) {
    return {
      storageVolumeM3: row.storageVolumeThouM3 * 1_000,
      storageRate: Math.max(0, Math.min(1, row.storageRatePct / 100)),
    };
  }
  if (row.effectiveVolumeThouM3 !== null) {
    return { storageVolumeM3: row.effectiveVolumeThouM3 * 1_000, storageRate: null };
  }
  if (row.capacityBasis === '有効') {
    return { storageVolumeM3: row.storageVolumeThouM3 * 1_000, storageRate: null };
  }
  return { storageVolumeM3: null, storageRate: null };
}

/** A row's reading at the report date, against its master's 有効 capacity. */
export function chubuReading(
  row: ParsedRow,
  reportDate: Date,
  masterActiveM3: number | null,
): Reading {
  const { storageVolumeThouM3: volume, storageRatePct: rate } = row;
  if (volume === null || rate === null) {
    return { state: 'unreadable', why: '貯水量 or 貯水率 is not a number' };
  }
  return {
    state: 'values',
    observations: [
      {
        observedAt: reportDate,
        ...storedStorage(
          { ...row, storageVolumeThouM3: volume, storageRatePct: rate },
          masterActiveM3,
        ),
        inflowM3s: row.inflowM3s,
        outflowM3s: row.outflowM3s,
        waterLevelM: row.waterLevelM,
      },
    ],
  };
}

/** The six dams alone, unreadable: what is recorded when the report cannot be read. */
function unreadableDams(why: string): Entry[] {
  return Object.entries(DAMS).map(([name, pref]) => ({
    key: name,
    name,
    pref,
    reading: { state: 'unreadable', why },
  }));
}

/**
 * Every row of the report but the totals, then any of the six dams it no
 * longer prints (unreadable). A row new on the page is recorded, not written.
 */
export function chubuEntries(html: string): Entry[] {
  const { reportDate, rows } = parseChubuHtml(html);
  if (!reportDate) return unreadableDams('no 「YYYY年MM月DD日」 report date on the page');
  const entries: Entry[] = rows
    .filter((row) => !TOTAL_ROW.test(row.name))
    .map((row) => ({
      key: row.name,
      name: row.name,
      ...(DAMS[row.name]
        ? { pref: DAMS[row.name] as string }
        : (OTHER_ROWS[row.name] ?? { pref: null, dontWrite: 'new on the report' })),
      reading: (dam) => chubuReading(row, reportDate, dam?.activeCapacityM3 ?? null),
    }));
  const printed = new Set(rows.map((r) => r.name));
  for (const e of unreadableDams('not on the report')) if (!printed.has(e.key)) entries.push(e);
  return entries;
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  let html: string;
  try {
    html = (await upstream.fetch(PAGE_URL)).text();
  } catch (err) {
    // The six dams are known in advance: record them unreadable, and the run
    // fails the job so it is retried.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: unreadableDams(why) };
  }
  const entries = chubuEntries(html);
  log(`${SOURCE_ID}: ${entries.length} rows`);
  return { entries };
});
