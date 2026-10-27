// apps/worker/src/tasks/ingest_kanda_suido.ts
//
// 苅田町水道課「水道の安定供給と安全性」 — 水源の状況 of the town's three sources,
// daily.
//
// Source: https://www.town.kanda.lg.jp/page/2021.html. 表1 (UTF-8 CMS table):
//   貯水池 | 有効貯水量 | 貯水量 | 貯水率％ | 前年同日貯水量   (volumes 千立方メートル)
// for 油木ダム / 山口ダム / 井ノ口池, closed by a row 「令和 8年 9月 28日現在」
// (date only: stamped 00:00 JST). The page's 更新日 moved with the date on the
// capture (both 2026-09-28).
//
// 山口ダム → 山口 (NDI 2248) by pin: pref 40 also has 山口調整池 (NDI 2487,
// 筑紫野市), which is locally called 山口ダム too. The town's 山口ダム feeds its
// 二崎浄水場 (same page: 「原水は油木ダム系今川と、山口ダムより取水」), i.e. the
// 福岡県 dam in 苅田町 whose master 有効 736,000 m³ is the page's 有効貯水量 736.
// 油木ダム is the 福岡県 dam kasenbosai and kitakyushu-suido also carry.
// 井ノ口池 (南原浄水場's source, 220 千m³) is not in the NDI master: recorded
// unresolved, with a not_dam_reason from migration 0219.
//
// Rate: 貯水量 / 有効貯水量 as printed. 山口 633 / 85.9 % = 737 千m³ (master 有効
// 736); 油木 6,463 / 44.7 % = 14,459 against a printed 14,450, the 洪水期
// (6/1–10/20) 利水容量 福岡県 lists for 油木 — below the master's annual 17,450.
// Trusted in 0219.
//
// Priority 293: the only source for 山口; for 油木 below kasenbosai (310) and
// kitakyushu-suido (300), above kyushu-nousei (279).
// Cron daily 06:13 UTC (15:13 JST).

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.KANDA_SUIDO_URL ?? 'https://www.town.kanda.lg.jp/page/2021.html';

const PREF_CODE = '40';
const SOURCE_ID = 'kanda-suido';

/** Page names the name rule would bind wrongly, pinned by NDI (see header). */
const NDI_PINS: Readonly<Record<string, string>> = {
  山口ダム: '2248',
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 貯水池 as printed ("山口ダム"); also the stamp and universe key. */
  name: string;
  /** 有効貯水量 (m³), the figure the rate divides by. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 「…現在」 date at 00:00 JST, or null if the line is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

/** "6,463千立方メートル" / "44.7%" → number; anything else → null. */
function num(cell: string | undefined): number | null {
  const m = flat(cell ?? '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)(?:千立方メートル|%)?$/);
  return m ? Number(m[1]) : null;
}

export function parseKandaSuigen(html: string): ParsedPage {
  const start = html.indexOf('<caption>表1</caption>');
  const body = start >= 0 ? html.slice(start) : '';
  const table = body.slice(0, body.indexOf('</table>'));

  const rows: ParsedRow[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 5) continue;
    const name = flat(cells[0] ?? '');
    if (!name) continue;
    const capacity = num(cells[1]);
    const volume = num(cells[2]);
    const rate = num(cells[3]);
    rows.push({
      name,
      capacityM3: capacity === null ? null : capacity * 1000,
      storageVolumeM3: volume === null ? null : volume * 1000,
      storageRate: rate === null ? null : rate / 100,
    });
  }

  const d = flat(table).match(/令和(元|\d+)年(\d{1,2})月(\d{1,2})日現在/);
  const observedAt = d
    ? new Date(
        Date.UTC(2018 + (d[1] === '元' ? 1 : Number(d[1])), Number(d[2]) - 1, Number(d[3]), -9),
      )
    : null;
  return { observedAt, rows };
}

/** A row's reading: a volume or a rate is a value; blank cells we leave unread. */
export function kandaReading(observedAt: Date, row: ParsedRow): Reading {
  if (row.storageVolumeM3 === null && row.storageRate === null) {
    return { state: 'unreadable', why: 'no 貯水量 or 貯水率' };
  }
  return {
    state: 'values',
    observations: [
      { observedAt, storageVolumeM3: row.storageVolumeM3, storageRate: row.storageRate },
    ],
  };
}

/**
 * Every 表1 row. 山口ダム binds by its NDI pin; the rest by exact name only
 * (the page's 貯水池 is the master name plus ダム), so 井ノ口池 stays unresolved.
 */
export function kandaEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map((row): Entry => {
    const pin = NDI_PINS[row.name];
    return {
      key: row.name,
      name: row.name,
      pref: PREF_CODE,
      bind: pin ? { ndi: pin } : { exact: true },
      reading: kandaReading(observedAt, row),
    };
  });
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const { observedAt, rows } = parseKandaSuigen((await upstream.fetch(PAGE_URL)).text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }
  return { entries: kandaEntries(observedAt, rows) };
});
