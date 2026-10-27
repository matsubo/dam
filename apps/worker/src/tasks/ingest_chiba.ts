// apps/worker/src/tasks/ingest_chiba.ts
//
// Phase B6 (#10): 千葉県 県内ダムの貯水状況 weekly snapshot.
//
// Source: https://www.pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html
// Page is updated weekly (Mondays; 更新日 a day or so later) with a static
// HTML table:
//   貯水率（％）| ダム名 | 水道事業者 | 貯水容量(m³) | 貯水量(m³) | 貯水率(%)
// Two tables (水道用 + 工業用水) total ~23 dams across 千葉県 (master has 50).
// The survey date is the table heading 「県内ダム貯水状況（令和X年M月D日現在）」.
// The chart image above the table has its own 「令和X年M月D日9時現在」 alt text,
// which is NOT updated reliably: on 2026-09-27 the page carried 9/14 data
// under a 9/7 alt, and reading the alt stamped the 9/14 figures onto the 9/7
// rows.
//
// We extract one observation per dam at the page's stated timestamp
// (snapped to JST → UTC). No flow / level data on this source, only
// storage volume + rate.
//
// Cron: daily at 02:30 UTC = 11:30 JST. The page changes about once a week
// (sometimes skipping one); polling daily and UPSERTing on the survey date
// picks the update up within a day. A weekly survey: the scan is dated.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.CHIBA_DAM_URL ?? 'https://www.pref.chiba.lg.jp/suisei/chosui/chosuijoukyou.html';

const PREF_CODE = '12';
const SOURCE_ID = 'chiba-suisei';

export interface ParsedRow {
  pageName: string;
  storageVolumeM3: Cell;
  /** 0..1, or the page's mark. */
  storageRate: Cell;
}

function parseNum(s: string): Cell {
  const t = s.replace(/[,\s　]/g, '');
  if (t === '-' || t === '−' || t === '欠測') return MARKED;
  return t ? cell(Number(t), false) : null;
}

/**
 * The table heading's 「県内ダム貯水状況（令和X年M月D日[H時]現在）」 → UTC.
 * The heading carries no hour; the survey is the 9時 reading, so H defaults
 * to 9 (JST).
 */
export function parseChibaTimestamp(html: string): Date | null {
  const m = html.match(/県内ダム貯水状況（令和(\d+)年(\d{1,2})月(\d{1,2})日(?:(\d{1,2})時)?現在/);
  if (!m) return null;
  // 令和元年 = 2019. 令和X = 2018 + X (令和8 = 2026).
  const yyyy = 2018 + Number(m[1]);
  const hour = m[4] === undefined ? 9 : Number(m[4]);
  return new Date(Date.UTC(yyyy, Number(m[2]) - 1, Number(m[3]), hour - 9, 0, 0, 0));
}

/**
 * Parse the Chiba page HTML. Skips subtotal rows where the No column is "-".
 */
export function parseChibaPage(html: string): ParsedRow[] {
  const cells = Array.from(html.matchAll(/<td[^>]*>([^<]{0,40})<\/td>/g)).map((m) =>
    (m[1] ?? '').trim(),
  );
  const out: ParsedRow[] = [];
  for (let i = 0; i + 5 < cells.length; i += 6) {
    const no = cells[i] ?? '';
    const name = cells[i + 1] ?? '';
    const op = cells[i + 2] ?? '';
    const volStr = cells[i + 4] ?? '';
    const rateStr = cells[i + 5] ?? '';
    if (!no || no === '-' || /小計/.test(op) || /小計/.test(name)) continue;
    if (!/^\d+$/.test(no)) continue;
    const rate = parseNum(rateStr);
    out.push({
      pageName: name,
      storageVolumeM3: parseNum(volStr),
      storageRate: typeof rate === 'number' ? rate / 100 : rate,
    });
  }
  return out;
}

export function chibaReading(row: ParsedRow, observedAt: Date | null): Reading {
  const state = cellState([row.storageVolumeM3, row.storageRate]);
  if (state === 'empty') return { state, mark: '貯水量 and 貯水率 marked' };
  if (state === 'unreadable') return { state, why: 'no 貯水量 or 貯水率' };
  if (!observedAt) return { state: 'unreadable', why: 'no 県内ダム貯水状況 heading date' };
  return {
    state,
    observations: [
      {
        observedAt,
        storageVolumeM3: numberIn(row.storageVolumeM3),
        storageRate: numberIn(row.storageRate),
      },
    ],
  };
}

/**
 * Every listed dam, keyed by its printed name (one dam can appear in both the
 * 水道用 and 工業用水 tables; the run merges the pair). The master is matched
 * exactly, with 一/二/三 read as 1/2/3: the master writes 東第2 and 第1袋倉
 * where the page prints 東第二 and 第一袋倉 (第二奥谷 keeps its kanji in the
 * master and is held by its stamp).
 */
export function chibaEntries(html: string): Entry[] {
  const observedAt = parseChibaTimestamp(html);
  return parseChibaPage(html).map((r) => ({
    key: r.pageName,
    name: r.pageName,
    pref: PREF_CODE,
    bind: {
      name: r.pageName.replace(/一/g, '1').replace(/二/g, '2').replace(/三/g, '3'),
      exact: true,
    },
    reading: chibaReading(r, observedAt),
  }));
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(PAGE_URL, { timeoutMs: 15_000 })).text();
  const entries = chibaEntries(html);
  log(`${SOURCE_ID}: ${entries.length} dams at ${parseChibaTimestamp(html)?.toISOString()}`);
  return { entries, dated: true };
});
