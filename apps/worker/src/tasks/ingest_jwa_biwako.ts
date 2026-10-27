// apps/worker/src/tasks/ingest_jwa_biwako.ts
//
// 水資源機構 琵琶湖総合管理所 堰諸量 — 琵琶湖 (master 琵琶湖開発), hourly.
//
// Source:
//   http://www.biwako-mizukanri.jp/daminfo1_h.json
//   (the data behind daminfo1_h.html, 堰諸量 1時間表示; linked from 水資源機構
//   リアルタイム水源情報. The host serves plain HTTP only; no robots.txt.)
//
// Payload: {"measure_date": "...", "data": [25 rows, oldest first]}, each row
// {"datestr": "YYYY-MM-DD HH:MM" (JST), "ana0" … "ana8": decimal strings}.
// Columns per daminfo1_h.html:
//   ana0 琵琶湖 河川水位 [m, B.S.L.]   ana1 総流入量 [m³/s]   ana2 総流出量 [m³/s]
//   ana3 洗堰全放流量   ana4 バイパス   ana5 バルブ   ana6 本堰   [m³/s]
//   ana7 / ana8 琵琶湖疏水１ / ２ 河川流量 [m³/s]
// The lake is the reservoir, so inflow/outflow are its 総流入量 / 総流出量
// (総流出量 = 洗堰 + 疏水 + 宇治発電 withdrawals), not the 洗堰 release alone.
//
// Level: the page prints B.S.L. (琵琶湖基準水位). B.S.L. ±0 = T.P. +84.371 m
// (国土交通省 琵琶湖河川事務所 FAQ, kkr.mlit.go.jp/biwako/info/faq/qlist/qlista/a32.html),
// so the stored level is T.P. elevation like every other dam's EL.m.
//
// No 貯水量 / 貯水率 is published; volume and rate stay NULL (not
// trusted_rate_basis). Missing values: any blank / non-numeric cell → null;
// the feed has no mark of its own for a missing reading.
//
// Priority 297 (JWA realtime siblings: jwa-yoshino / jwa-chikugo). The only
// other source on this dam is mudam (280). Cron hourly at :58; each run
// re-upserts the 24-hour window so an outage self-heals.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const DATA_URL = process.env.JWA_BIWAKO_URL ?? 'http://www.biwako-mizukanri.jp/daminfo1_h.json';

const SOURCE_ID = 'jwa-biwako';
const PREF_CODE = '25';
/** The page's 局名 for the lake — the universe key and the stamp. */
const STATION = '琵琶湖';
const MASTER_NAME = '琵琶湖開発';
/** T.P. elevation of B.S.L. ±0 m. */
const BSL_DATUM_TP_M = 84.371;

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function cellValue(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Every row with a parsable "YYYY-MM-DD HH:MM" JST time, oldest first. */
export function parseBiwakoDamInfo(text: string): ParsedRow[] {
  const body = JSON.parse(text.replace(/^\uFEFF/, '')) as { data?: Record<string, unknown>[] };
  const out: ParsedRow[] = [];
  for (const r of body.data ?? []) {
    const m = String(r.datestr ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!m) continue;
    const observedAt = new Date(
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
    );
    const bsl = cellValue(r.ana0);
    out.push({
      observedAt,
      // Rounded to the mm: the B.S.L. reading has cm resolution, and the float
      // sum would otherwise store 84.04100000000001.
      waterLevelM: bsl === null ? null : Math.round((BSL_DATUM_TP_M + bsl) * 1000) / 1000,
      inflowM3s: cellValue(r.ana1),
      outflowM3s: cellValue(r.ana2),
    });
  }
  return out;
}

/** The lake's reading: every hour that carries a value, or why none could be read. */
export function biwakoReading(page: { text: string } | { failed: string }): Reading {
  if ('failed' in page) return { state: 'unreadable', why: page.failed };
  let rows: ParsedRow[];
  try {
    rows = parseBiwakoDamInfo(page.text);
  } catch (err) {
    return { state: 'unreadable', why: `not JSON: ${err instanceof Error ? err.message : err}` };
  }
  const observations: Observed[] = rows.filter(
    (r) => r.waterLevelM !== null || r.inflowM3s !== null || r.outflowM3s !== null,
  );
  if (observations.length === 0) {
    return { state: 'unreadable', why: `no value in ${rows.length} hourly rows` };
  }
  return { state: 'values', observations };
}

/**
 * The provider publishes exactly this one station, known in advance: listed
 * even when the feed fails, so /coverage can tell a failed read from absence.
 */
export function biwakoEntries(page: { text: string } | { failed: string }): Entry[] {
  return [
    {
      key: STATION,
      name: STATION,
      pref: PREF_CODE,
      bind: { name: MASTER_NAME },
      reading: biwakoReading(page),
    },
  ];
}

async function fetchFeed(upstream: Upstream): Promise<{ text: string } | { failed: string }> {
  try {
    return { text: (await upstream.fetch(DATA_URL)).text() };
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const page = await fetchFeed(upstream);
  if ('failed' in page) log(`${SOURCE_ID}: ${page.failed}`);
  return { entries: biwakoEntries(page) };
});
