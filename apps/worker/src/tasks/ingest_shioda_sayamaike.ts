// apps/worker/src/tasks/ingest_shioda_sayamaike.ts
//
// 上田市塩田平土地改良区 (水土里ネット塩田平)「沢山池の状況図」 — 沢山池 (長野県上田市,
// NDI 961, 総貯水量 1,082 千m³), every 10 minutes.
//
// Source: the 状況図 page http://www.midorinet-shioda.or.jp/reservoir/sayamaike/
// fills its table from one CSV, data/SFTP.csv: a single CRLF line of 12
// comma-separated fields, in the order the page's script reads them
// (2026-09-28):
//   0 現在貯水位 (E.L.m)    1 総貯水量 (m³, static)  2 現在貯水量 (m³)
//   3 現在貯水率 (%, integer)  4–6 利水放流 / 洪水吐放流 / 全放流量 (m³/s)
//   7 全流入量 (m³/s)  8 時間雨量 (mm)  9 累計雨量 (mm)  10 外気温 (℃)
//   11 index of the water-level picture
// The page stopped showing fields 4–6 on 2026-03-13 (「非表示20260313」 in its
// script), so no outflow is stored. The 常時満水位 on the page is 600.00 E.L.m.
//
// Time: the CSV carries none, and the page's 「現在」 time comes from a script
// that returns the server's clock. The file is re-uploaded (by SFTP, per its
// name) about a minute past every 10-minute mark: Last-Modified 06:51:10 and
// 07:01:10 GMT on 2026-09-28. A reading is stamped at its Last-Modified
// floored to the 10-minute mark.
//
// Rate: 貯水率 is 現在貯水量 / 総貯水量 as a whole percent (86,035 /
// 1,082,409 = 7.9 % → 8), i.e. on the total, not the 有効 995 千m³ of the
// master; it is stored as published and not trusted, so the site divides the
// volume by the master's capacity.
//
// License: the site states no terms of use; every page carries
// 「copyright © 上田市塩田平土地改良区 All Rights Reserved.」 robots.txt returns 404.
// Only the observed numbers are stored, with the source named.
//
// Priority 285. No other source publishes 沢山池. Cron hourly at :05.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const SOURCE_ID = 'shioda-sayamaike';
const CSV_URL =
  process.env.SHIODA_SAYAMAIKE_URL ??
  'http://www.midorinet-shioda.or.jp/reservoir/sayamaike/data/SFTP.csv';
const NAME = '沢山池';
const PREF_CODE = '20';
const TEN_MINUTES_MS = 10 * 60_000;

export interface SayamaikeReading {
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  /** 0..1 */
  storageRate: number | null;
  inflowM3s: number | null;
  rainfallMm: number | null;
}

/** The CSV line and the response's Last-Modified → one reading. Throws on a layout change. */
export function parseSayamaikeCsv(csv: string, lastModified: string | null): SayamaikeReading {
  const fields = csv.trim().split(',');
  if (fields.length < 12) {
    throw new Error(`${SOURCE_ID}: expected 12 CSV fields, got ${fields.length} — layout change?`);
  }
  const modified = lastModified ? Date.parse(lastModified) : Number.NaN;
  if (Number.isNaN(modified)) {
    throw new Error(
      `${SOURCE_ID}: no usable Last-Modified (${lastModified}); cannot date the reading`,
    );
  }
  const num = (i: number): number | null => {
    const s = (fields[i] ?? '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const rate = num(3);
  return {
    observedAt: new Date(Math.floor(modified / TEN_MINUTES_MS) * TEN_MINUTES_MS),
    waterLevelM: num(0),
    storageVolumeM3: num(2),
    storageRate: rate === null ? null : rate / 100,
    inflowM3s: num(7),
    rainfallMm: num(8),
  };
}

/**
 * The reading of one CSV fetch. Rain alone does not count: the reservoir has
 * values when level, volume, rate or inflow carries one.
 */
export function sayamaikeReading(csv: string, lastModified: string | null): Reading {
  const r = parseSayamaikeCsv(csv, lastModified);
  const hasValue =
    r.waterLevelM !== null ||
    r.storageVolumeM3 !== null ||
    r.storageRate !== null ||
    r.inflowM3s !== null;
  if (!hasValue) return { state: 'unreadable', why: 'no level, volume, rate or inflow' };
  // outflowM3s stays unset: the release columns are no longer shown on the page.
  return { state: 'values', observations: [r] };
}

/**
 * The one reservoir the provider publishes, matched only by its exact name
 * inside 長野 (a namesake elsewhere must not bind). A layout change makes it
 * unreadable.
 */
export function sayamaikeEntries(reading: Reading | (() => Reading)): Entry[] {
  return [{ key: NAME, name: NAME, pref: PREF_CODE, bind: { exact: true }, reading }];
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  let csv: string;
  let lastModified: string | null;
  try {
    const r = await upstream.fetch(CSV_URL);
    csv = r.text();
    lastModified = r.headers.get('last-modified');
  } catch (err) {
    // The error already names the source and URL.
    const why = err instanceof Error ? err.message : String(err);
    log(why);
    return { entries: sayamaikeEntries({ state: 'unreadable', why }) };
  }
  return { entries: sayamaikeEntries(() => sayamaikeReading(csv, lastModified)) };
});
