// apps/worker/src/tasks/ingest_jwa_chiba.ts
//
// 水資源機構 千葉用水総合管理所 房総導水路管理所 — 2 JWA管理ダム 日次.
//
//   長柄ダム (千葉 12) / 東金ダム (千葉 12)
//
// Source:
//   https://www.water.go.jp/kanto/bouso/01shinchaku/syusuijouhou/syusuijouhou.html
// Format: UTF-8 HTML, manually updated on business days (閉庁日を除き).
//   Timestamp: "令和X年Y月Z日（0時現在）" — midnight JST of the stated date.
//   Values embedded between HTML comments:
//     <!-- ↓↓↓↓↓{ダム}の水位を入力↓↓↓↓↓ -->  水位　 E.L. XX.XXm  <!-- ↑↑... -->
//     <!-- ↓↓↓↓↓{ダム}の貯水率を入力↓↓↓↓↓ --> 貯水率　　XX.X %  <!-- ↑↑... -->
// Coverage:
//   Not on 千葉県水道局 page (pref water supply dams are different facilities).
//   Only water level (EL.m) + storage rate (%) — no volume or flow.
// Priority: 302 (国/JWA管理, daily, same as kkr-mlit-dam).
// Cron: daily at 03:00 UTC = 12:00 JST.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';
import type { Upstream } from '../ingest/upstream.ts';

const PAGE_URL =
  process.env.JWA_CHIBA_BOUSO_URL ??
  'https://www.water.go.jp/kanto/bouso/01shinchaku/syusuijouhou/syusuijouhou.html';

const PREF_CODE = '12';
const SOURCE_ID = 'jwa-chiba-bouso';

/** The page lists both dams every day, even one with no 水位/貯水率 to parse. */
const DAMS: readonly string[] = ['長柄ダム', '東金ダム'];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  htmlName: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse "令和X年Y月Z日（0時現在）" (midnight JST) → UTC.
 * 令和 era: Gregorian year = 2018 + reiwa year.
 */
export function parseJwaChibaTimestamp(html: string): Date | null {
  const m = html.match(/令和(\d+)年(\d+)月(\d+)日（0時現在）/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  if ([yr, mo, dy].some(Number.isNaN)) return null;
  // Midnight JST (UTC+9) → UTC: subtract 9 hours
  const d = new Date(Date.UTC(yr, mo - 1, dy, -9, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract the value between a start-comment and the next end-comment. */
function extractBetweenComments(html: string, startMarker: string): string {
  const startIdx = html.indexOf(startMarker);
  if (startIdx < 0) return '';
  const afterStart = html.indexOf('-->', startIdx) + 3;
  const endIdx = html.indexOf('<!--', afterStart);
  return endIdx > afterStart ? html.slice(afterStart, endIdx) : html.slice(afterStart);
}

/** Parse all fields for one dam from the page HTML. */
export function parseDam(html: string, htmlName: string, observedAt: Date): ParsedRow | null {
  // Water level: "水位　 E.L. 74.18m"
  const levelSection = extractBetweenComments(html, `↓↓↓↓↓${htmlName}の水位を入力↓↓↓↓↓`);
  const level = Number(levelSection.match(/E\.L\.\s*([\d.]+)\s*m/)?.[1]);
  const waterLevelM = Number.isFinite(level) ? level : null;

  // Storage rate: "貯水率　　92.5 %" → divide by 100 → [0, 1] fraction
  const rateSection = extractBetweenComments(html, `↓↓↓↓↓${htmlName}の貯水率を入力↓↓↓↓↓`);
  const ratePct = Number(rateSection.match(/([\d.]+)\s*%/)?.[1]);
  const storageRate = Number.isFinite(ratePct) ? Math.max(0, Math.min(1, ratePct / 100)) : null;

  if (waterLevelM === null && storageRate === null) return null;

  return { htmlName, observedAt, waterLevelM, storageRate };
}

type Page = { html: string } | { failed: string };

function pageReadings(page: Page): (htmlName: string) => Reading {
  if ('failed' in page) return () => ({ state: 'unreadable', why: page.failed });
  const { html } = page;
  const observedAt = parseJwaChibaTimestamp(html);
  if (!observedAt) return () => ({ state: 'unreadable', why: 'no 「令和X年Y月Z日（0時現在）」' });
  return (htmlName) => {
    const row = parseDam(html, htmlName, observedAt);
    if (!row) return { state: 'unreadable', why: `no 水位 or 貯水率 parsed for ${htmlName}` };
    return {
      state: 'values',
      observations: [{ observedAt, waterLevelM: row.waterLevelM, storageRate: row.storageRate }],
    };
  };
}

/** Both dams, known in advance: a page that failed leaves them unreadable, never unlisted. */
export function jwaChibaEntries(page: Page): Entry[] {
  const readingOf = pageReadings(page);
  return DAMS.map((htmlName) => ({
    key: htmlName,
    name: htmlName,
    pref: PREF_CODE,
    reading: readingOf(htmlName),
  }));
}

async function fetchPage(upstream: Upstream): Promise<Page> {
  try {
    return { html: (await upstream.fetch(PAGE_URL)).text() };
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) };
  }
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const page = await fetchPage(upstream);
  if ('failed' in page) log(`${SOURCE_ID}: ${page.failed}`);
  return { entries: jwaChibaEntries(page) };
});
