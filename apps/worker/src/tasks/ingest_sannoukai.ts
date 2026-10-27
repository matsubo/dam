// apps/worker/src/tasks/ingest_sannoukai.ts
//
// 山王海土地改良区「ダムの状況」— 山王海ダム / 葛丸ダム (東北農政局の国営
// 親子ダム, 管理 山王海土地改良区) の貯水量, weekly.
//
// Source: https://sannoukai.jp/condition/ — 「毎週月曜日に更新します。」 The
// readings are not in the page text: the WordPress template writes them into
// inline script, which draws the reservoir picture in the browser,
//   var sMax = 3840;  // 山王海ダム　最大 3840
//   var kMax = 500;   // 葛丸ダム　　最大  500
//   var sNow = 1833;
//   var kNow = 432;
// in 万㎥. Each dam block (<div id="dam_s">, <div id="dam_k">) is headed
// 「山王海ダム情報」/「葛丸ダム情報」, and its id suffix names the variable. A
// value of 0 is the page's no-data marker (it shows the text 'zero' instead
// of a level), so it is provider-marked empty, not an empty reservoir.
//
// Date: the date the page shows is the viewer's clock (`new Date()`), not the
// survey's, so it is useless. The survey date is taken from the page's own
// WordPress REST record (<link rel="alternate" type="application/json">),
// whose modified_gmt moves when the readings are edited (2026-09-28 08:46
// JST, a Monday). Stamped 00:00 JST of that date, like the other survey-date
// sources; a same-day correction lands on the same row.
//
// Rate: not stored. The page's 貯水率 is its own script dividing by the
// constants above (3840 = 山王海's 総貯水容量), not a published figure; the
// site derives the rate from the stored volume as for any untrusted source.
//
// Both dams are on kasenbosai (310), which has carried no reading since
// 2026-08-04 and lists them as empty (has_data=false). Priority 277 stays
// below it, so a kasenbosai reading wins again whenever there is one.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.SANNOUKAI_URL ?? 'https://sannoukai.jp/condition/';

const PREF_CODE = '03';
const SOURCE_ID = 'sannoukai';

// --- parsing ----------------------------------------------------------------

export interface ParsedDam {
  /** Heading minus 「情報」 (「山王海ダム」); also the stamp and universe key. */
  name: string;
  /** null when the script has no value or the page's 0 no-data marker. */
  storageVolumeM3: number | null;
  /** The page itself says there is no reading (its 0 marker). */
  markedEmpty: boolean;
}

export function parseSannoukaiPage(html: string): ParsedDam[] {
  const dams: ParsedDam[] = [];
  for (const m of html.matchAll(
    /<div id="dam_([a-z]+)"[^>]*>[\s\S]*?<h3 class="dam_name">([^<]+?)情報<\/h3>/g,
  )) {
    const key = m[1] as string;
    const name = (m[2] as string).normalize('NFKC').trim();
    const value = html.match(new RegExp(`var ${key}Now\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*;`))?.[1];
    const man = value === undefined ? null : Number(value);
    dams.push({
      name,
      storageVolumeM3: man !== null && man > 0 ? Math.round(man * 10_000) : null,
      markedEmpty: man === 0,
    });
  }
  return dams;
}

/** The page's WordPress REST record, from its alternate JSON link. */
export function findRestUrl(html: string): string | null {
  for (const link of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = link[0];
    if (!/rel="alternate"/.test(tag) || !/type="application\/json"/.test(tag)) continue;
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (href?.includes('/wp-json/')) return href;
  }
  return null;
}

/** 00:00 JST of the JST date the record was last edited. */
export function observedAtFromRest(record: unknown): Date | null {
  const gmt = (record as { modified_gmt?: unknown })?.modified_gmt;
  if (typeof gmt !== 'string') return null;
  const edited = new Date(`${gmt}Z`);
  if (Number.isNaN(edited.getTime())) return null;
  const jst = new Date(edited.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), -9));
}

// --- entries ----------------------------------------------------------------

/** A dam's reading at the survey date (null: the REST record gave none). */
function damReading(d: ParsedDam, observedAt: Date | null): Reading {
  if (d.markedEmpty) return { state: 'empty', mark: 'Now = 0 (the page shows its zero text)' };
  if (d.storageVolumeM3 === null)
    return { state: 'unreadable', why: 'no …Now value in the script' };
  if (!observedAt) return { state: 'unreadable', why: 'no edit date from the REST record' };
  return { state: 'values', observations: [{ observedAt, storageVolumeM3: d.storageVolumeM3 }] };
}

/**
 * Every dam block on the page. Binds only the dam of the same name (the live
 * twin of a （元）/（再） pair), never a prefix.
 */
export function sannoukaiEntries(html: string, observedAt: Date | null): Entry[] {
  return parseSannoukaiPage(html).map((d) => ({
    key: d.name,
    name: d.name,
    pref: PREF_CODE,
    bind: { exact: true },
    reading: damReading(d, observedAt),
  }));
}

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const html = (await upstream.fetch(PAGE_URL)).text();
  const restUrl = findRestUrl(html);
  let observedAt: Date | null = null;
  try {
    if (restUrl) observedAt = observedAtFromRest((await upstream.fetch(restUrl)).json<unknown>());
  } catch (err) {
    log(`${SOURCE_ID}: REST record unreadable: ${err instanceof Error ? err.message : err}`);
  }
  if (!observedAt) log(`${SOURCE_ID}: no edit date from ${restUrl ?? '(no REST link)'}`);
  const entries = sannoukaiEntries(html, observedAt);
  if (entries.length === 0) {
    throw new Error(`${SOURCE_ID}: no dam blocks on ${PAGE_URL} — layout change?`);
  }
  return { entries, dated: true };
});
