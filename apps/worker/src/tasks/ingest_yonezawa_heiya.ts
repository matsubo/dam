// apps/worker/src/tasks/ingest_yonezawa_heiya.ts
//
// 米沢平野土地改良区「用水状況」— 水窪ダム (東北農政局, 管理 米沢平野土地改良区)
// の貯水量, weekly.
//
// Source: https://www.yonezawa-heiya.or.jp/pages/150/ (水利・施設情報 > 用水状況).
// The page shows the latest reading as a slider caption,
//   「2026.9.28現在、貯水量は 20,343.9千m3です。」
// updated 「毎週月曜日（祝日･休日の場合は翌日）」. Its 「令和８年度」 link opens the
// fiscal-year archive (pages/169 for R8), one caption per week from 4月 on,
// so every run re-reads the whole year and the first run backfills it. The
// archive link is discovered from pages/150, never pinned: each 年度 gets a
// new page id (R7 is pages/163).
//
// No time of day is published, so a reading is stamped 00:00 JST of its date.
// Volume only: the page prints no level and no rate.
//
// Cadence: weekly all year; the 令和７年度 archive (pages/163) has 51 readings,
// 2025.4.7 – 2026.3.30, the longest gap 14 days (年末年始). The derived
// freshness threshold covers that, so there is no override.
//
// 水窪 is in no other feed (not on kasenbosai, not in 山形県's bousai table),
// so priority 278 ties with nothing on it.

import { ingestTask } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const PAGE_URL = process.env.YONEZAWA_HEIYA_URL ?? 'https://www.yonezawa-heiya.or.jp/pages/150/';

const PREF_CODE = '06';
const SOURCE_ID = 'yonezawa-heiya';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

// --- parsing ----------------------------------------------------------------

export interface ParsedReading {
  observedAt: Date;
  storageVolumeM3: number;
}

/**
 * Every 「Y.M.D現在、貯水量は N千m3」 caption, one reading per date. NFKC first:
 * the captions are hand-typed and sometimes carry a full-width 「ｍ」.
 */
export function parseYonezawaReadings(html: string): ParsedReading[] {
  const text = html.normalize('NFKC');
  const byDate = new Map<number, ParsedReading>();
  for (const m of text.matchAll(
    /(\d{4})\.(\d{1,2})\.(\d{1,2})現在、貯水量は\s*([\d,]+(?:\.\d+)?)\s*千m3/g,
  )) {
    const observedAt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), -9));
    const thousands = Number((m[4] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(thousands)) continue;
    byDate.set(observedAt.getTime(), {
      observedAt,
      storageVolumeM3: Math.round(thousands * 1000),
    });
  }
  return [...byDate.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

/** The dam the page reports on, from its 「水窪ダム用水状況」 heading text node. */
export function parseDamName(html: string): string | null {
  for (const node of html.split(/<[^>]*>/)) {
    const m = node
      .normalize('NFKC')
      .trim()
      .match(/^(\S+ダム)用水状況$/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The current fiscal year's archive: the first 「令和…年度」 link on the page. */
export function findArchiveUrl(html: string, base: string): string | null {
  for (const a of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = (a[2] ?? '')
      .replace(/<[^>]*>/g, '')
      .normalize('NFKC')
      .trim();
    if (/^令和\d+年度/.test(label) && a[1]) return new URL(a[1], base).toString();
  }
  return null;
}

// --- entries ----------------------------------------------------------------

/**
 * The one dam the page reports on, with every weekly reading of the current
 * page and the fiscal-year archive (null when it could not be read). Binds
 * only the dam of the same name (the live twin of a （元）/（再） pair).
 */
export function yonezawaEntry(current: string, archive: string | null): Entry {
  const name = parseDamName(current);
  if (!name) throw new Error(`${SOURCE_ID}: no 「…ダム用水状況」 heading on ${PAGE_URL}`);
  const readings = new Map<number, ParsedReading>();
  for (const r of parseYonezawaReadings(current)) readings.set(r.observedAt.getTime(), r);
  if (archive !== null) {
    for (const r of parseYonezawaReadings(archive)) readings.set(r.observedAt.getTime(), r);
  }
  return {
    key: name,
    name,
    pref: PREF_CODE,
    bind: { exact: true },
    reading:
      readings.size > 0
        ? { state: 'values', observations: [...readings.values()] }
        : { state: 'unreadable', why: 'no 「現在、貯水量は」 caption' },
  };
}

async function fetchHtml(url: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  return r.status === 200 ? await r.text() : null;
}

export default ingestTask(SOURCE_ID, async (log) => {
  const html = await fetchHtml(PAGE_URL);
  if (html === null) throw new Error(`${SOURCE_ID}: ${PAGE_URL} did not return 200`);
  const archiveUrl = findArchiveUrl(html, PAGE_URL);
  const archive = archiveUrl ? await fetchHtml(archiveUrl) : null;
  if (archive === null) log(`${SOURCE_ID}: archive ${archiveUrl ?? '(no link)'} not read`);
  return { entries: [yonezawaEntry(html, archive)], dated: true };
});
