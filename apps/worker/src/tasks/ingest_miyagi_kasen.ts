// apps/worker/src/tasks/ingest_miyagi_kasen.ts
//
// 宮城県土木総合情報システム ダム現況表 — 21 ダム, hourly.
//
//   18 県管理: 大倉/樽水/七北田/南川/宮床/惣の関/川内沢/漆沢/化女沼/
//              上大沢/二ツ石/岩堂沢/花山/荒砥沢/小田/栗駒/長沼/払川
//    3 国管理: 鳴子/釜房/七ヶ宿 (MLIT Tohoku)
//
// Source:
//   https://www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet
// Format: Shift_JIS HTML, no session. Two GETs per run: the latest table and
// the previous hour (most stations report well after the table flips hours).
// Columns per dam (10 values after name/manager):
//   [0] 貯水位 (EL.m)
//   [1] 貯水量 (10³m³)
//   [2] 空容量 (10³m³)      — not stored
//   [3] 全流入量 (m³/s)
//   [4] 全放流量 (m³/s)
//   [5] 調整流量 (m³/s)     — not stored
//   [6] 流域平均雨量 (mm)   — not stored
//   [7] 流域平均累加雨量 (mm)— not stored
//   [8] 貯水率(利水容量) (%)
//   [9] 貯水率(有効容量) (%) — not stored (use [8])
// Timestamp: "観測時刻：YYYY年MM月DD日 HH時MM分" JST.
// Priority 308, matching other 防災Web prefectural sources.

import { ingestTask } from '../ingest/run.ts';
import type { Entry } from '../ingest/types.ts';

const DATA_URL =
  process.env.MIYAGI_KASEN_URL ??
  'https://www.dobokusougou.pref.miyagi.jp/miyagi/servlet/Gamen42Servlet';

const PREF_CODE = '04';
const SOURCE_ID = 'miyagi-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  miyagiName: string;
  stationNo: string;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

/** "YYYY年MM月DD日 HH時MM分" JST → UTC Date */
export function parseMiyagiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})年(\d{2})月(\d{2})日\s+(\d{2})時(\d{2})分/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * "YYYY-MM-DD-HH-MM" JST (from commonParam.dispDate) → UTC Date.
 * The site now renders 観測時刻 dynamically; dispDate in the inline JS is the
 * authoritative timestamp when the label element is empty.
 */
export function parseMiyagiDispDate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The same 現況表 `hoursBack` hours before the page's own dispDate, requested
 * the way the site's 時刻切替 buttons do: the page's commonParam with dispDate
 * replaced, passed as `?param=common=…` and encodeURI'd. Null when the page
 * carries no commonParam to rewrite.
 */
export function earlierTableUrl(baseUrl: string, html: string, hoursBack: number): string | null {
  const common = html.match(/var commonParam = "([^"]*)"/)?.[1];
  const disp = common?.match(/dispDate:(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})/)?.[1];
  const at = disp ? parseMiyagiDispDate(disp) : null;
  if (!common || !at) return null;
  // Shift into JST wall-clock so the UTC getters read JST fields.
  const jst = new Date(at.getTime() + (9 - hoursBack) * 3_600_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  const earlier = `${jst.getUTCFullYear()}-${p(jst.getUTCMonth() + 1)}-${p(jst.getUTCDate())}-${p(jst.getUTCHours())}-${p(jst.getUTCMinutes())}`;
  const rewritten = common.replace(/dispDate:[^$]*/, `dispDate:${earlier}`);
  return `${baseUrl}?param=${encodeURI(`common=${rewritten}`)}`;
}

function parseNum(s: string): number | null {
  const clean = s.replace(/[^\d.-]/g, '');
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export function parseMiyagiTable(html: string): ParsedRow[] {
  // Primary: inline "観測時刻：YYYY年MM月DD日 HH時MM分" label (older site format).
  // Fallback: commonParam.dispDate "YYYY-MM-DD-HH-MM" injected by JS (current format).
  const tsLabelMatch = html.match(
    /観測時刻[：:]\s*(\d{4})年(\d{2})月(\d{2})日\s+(\d{2})時(\d{2})分/,
  );
  const dispDateMatch = html.match(/dispDate:(\d{4}-\d{2}-\d{2}-\d{2}-\d{2})/);

  const observedAt = tsLabelMatch
    ? parseMiyagiTimestamp(tsLabelMatch[0])
    : dispDateMatch
      ? parseMiyagiDispDate(dispDateMatch[1] ?? '')
      : null;
  if (!observedAt) return [];

  const rows: ParsedRow[] = [];

  // Each dam is one <tr>: a stationNo','XXXXXX'")>DAM_NAME</span> cell, the
  // 県/国 manager cell, then 10 <div class="dat2"> value cells. The 国 rows
  // (鳴子/釜房/七ヶ宿) never close their <div>, so a value is the text up to
  // the next tag, and a row runs to its own </tr>.
  for (const m of html.matchAll(/stationNo','(\d+)'\)">([^<]+)<\/span>/g)) {
    const pos = m.index ?? 0;
    const end = html.indexOf('</tr>', pos);
    const section = html.slice(pos, end === -1 ? undefined : end);
    const vals = Array.from(section.matchAll(/<div class="dat2"[^>]*>([^<]*)/g)).map((v) =>
      (v[1] ?? '').replace(/&nbsp;/g, ' ').trim(),
    );
    // Fewer than the 10 columns means the row is not the table we know; keep
    // the station (it is still published) but trust none of its cells.
    const cell = (i: number): number | null => (vals.length >= 10 ? parseNum(vals[i] ?? '') : null);
    const volumeThou = cell(1);
    const ratePct = cell(8);

    rows.push({
      miyagiName: m[2]?.trim() ?? '',
      stationNo: m[1] ?? '',
      observedAt,
      waterLevelM: cell(0),
      storageVolumeM3: volumeThou !== null ? volumeThou * 1_000 : null,
      inflowM3s: cell(3),
      outflowM3s: cell(4),
      storageRate: ratePct !== null ? ratePct / 100 : null,
    });
  }

  return rows;
}

// --- task -------------------------------------------------------------------

async function fetchTable(url: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) return null;
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

/**
 * The readings one run stores: the previous hour's table, then the latest.
 *
 * The table flips to the new hour as soon as the first stations report, and
 * most land well after that, so at the :06 cron the latest hour is mostly
 * blank rows — reading it alone never stored 岩堂沢 or 二ツ石 at all. The
 * previous hour is complete by then, so every station arrives an hour late at
 * worst; ON CONFLICT keeps the re-reads idempotent.
 *
 * Earlier rows must be strictly older than the latest table: were the server
 * ever to ignore the requested time, the same (dam, time) twice in one INSERT
 * would make ON CONFLICT reject the whole batch. A station still waiting on
 * its telemetry (no level, no volume) carries nothing to store.
 */
export function readingsToStore(latest: ParsedRow[], earlier: ParsedRow[]): ParsedRow[] {
  const latestMs = latest[0]?.observedAt.getTime() ?? Number.POSITIVE_INFINITY;
  return [...earlier.filter((p) => p.observedAt.getTime() < latestMs), ...latest].filter(
    (p) => p.waterLevelM !== null || p.storageVolumeM3 !== null,
  );
}

/**
 * The previous hour's rows, or none. The fetch is a best-effort extra: a
 * timeout, DNS failure or reset here must not throw past the latest table,
 * which would cost the run its universe and every observation.
 */
export async function fetchEarlierRows(
  latestHtml: string,
  log: (s: string) => void,
  fetchText: (url: string) => Promise<string | null> = fetchTable,
): Promise<ParsedRow[]> {
  const url = earlierTableUrl(DATA_URL, latestHtml, 1);
  const html = url
    ? await fetchText(url).catch((err: unknown) => {
        log(`${SOURCE_ID}: previous-hour fetch failed: ${String(err)}`);
        return null;
      })
    : null;
  if (html === null) {
    log(`${SOURCE_ID}: previous-hour table unavailable`);
    return [];
  }
  return parseMiyagiTable(html);
}

/**
 * Every station of the latest table, with the readings this run stores for
 * it. A station still blank in both tables (「　」 until its telemetry lands)
 * is unreadable: the table prints no 欠測 mark for it.
 */
export function miyagiEntries(latest: ParsedRow[], earlier: ParsedRow[]): Entry[] {
  const stored = readingsToStore(latest, earlier);
  return latest
    .filter((r) => r.miyagiName)
    .map((r): Entry => {
      const observations = stored
        .filter((p) => p.stationNo === r.stationNo)
        .map((p) => ({
          observedAt: p.observedAt,
          waterLevelM: p.waterLevelM,
          storageVolumeM3: p.storageVolumeM3,
          inflowM3s: p.inflowM3s,
          outflowM3s: p.outflowM3s,
          storageRate: p.storageRate,
        }));
      return {
        key: r.stationNo,
        name: r.miyagiName,
        pref: PREF_CODE,
        reading:
          observations.length > 0
            ? { state: 'values', observations }
            : { state: 'unreadable', why: 'no 貯水位 or 貯水量 in either table' },
      };
    });
}

export default ingestTask(SOURCE_ID, async (log) => {
  const html = await fetchTable(DATA_URL);
  if (html === null) throw new Error(`${SOURCE_ID}: latest table fetch failed`);
  const rows = parseMiyagiTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  return { entries: miyagiEntries(rows, await fetchEarlierRows(html, log)) };
});
