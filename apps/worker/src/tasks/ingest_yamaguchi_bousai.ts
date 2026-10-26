// apps/worker/src/tasks/ingest_yamaguchi_bousai.ts
//
// 山口県土木防災情報システム ダム観測局 — 23 ダム hourly.
//
//   小瀬川/生見川/御庄川/中山川/平瀬/今富/厚東川/真締川/末武川/木屋川/
//   向道/菅野/川上/屋代/佐波川/荒谷/一の坂/湯免/大坊/見島/阿武川/
//   黒杭川/黒杭川上流
//
// Source:
//   https://y-bousai.pref.yamaguchi.lg.jp/sp/dam/spdmObserve.aspx?stncd=NNN
//   One ASPX page per station (redirects to add current obsdt).
//   UTF-8 HTML; the データ table lists the last 24 hours at 10-minute steps,
//   oldest first. On-the-hour rows carry class "hour_HH", the others
//   "dotted minute_HH"; the window opens with a partial-hour row
//   (class "hour_HHb", e.g. 21:40). None of the data <tr>s is closed.
//
// Table columns per row:
//   col[0] 観測時刻 "YYYY/MM/DD<br />HH:MM" JST
//   col[1] 貯水位 [m]
//   col[2] 貯水率 [%]
//   col[3] 流入量 [m³/s]
//   col[4] 全放流量 [m³/s]
//   col[5] 調整流量 [m³/s] — skip
//   Missing values: "****" (欠測) or empty (未観測), per the site legend.
//   An outage can also print as 貯水位 0.00 with every other column 0.
//   No storageVolumeM3 available in this system.
//
// Every run writes all 24 hourly rows of the window, so an outage shorter
// than a day heals on the next successful run. The station list is the
// universe: a page that fails to load is unreadable, one whose every hourly
// row is ****/blank is provider-marked empty.
//
// Priority 308. Cron hourly at :46.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';

const BASE_URL =
  process.env.YAMAGUCHI_BOUSAI_URL ??
  'https://y-bousai.pref.yamaguchi.lg.jp/sp/dam/spdmObserve.aspx';

const PREF_CODE = '35';
const SOURCE_ID = 'yamaguchi-bousai';
// 小瀬川ダム sits on the prefectural boundary and is registered under
// pref_code='34' (広島) in the master, so its lookup includes Hiroshima.
const KOZEGAWA_SCOPE: readonly string[] = ['34', PREF_CODE];

// Station map from sp/map/spWideMap.aspx (damCntHid=23)
const STATIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '001', name: '小瀬川ダム' },
  { code: '002', name: '生見川ダム' },
  { code: '003', name: '御庄川ダム' },
  { code: '004', name: '中山川ダム' },
  { code: '005', name: '黒杭川ダム' },
  { code: '006', name: '屋代ダム' },
  { code: '007', name: '向道ダム' },
  { code: '008', name: '菅野ダム' },
  { code: '009', name: '川上ダム' },
  { code: '010', name: '末武川ダム' },
  { code: '011', name: '佐波川ダム' },
  { code: '012', name: '荒谷ダム' },
  { code: '013', name: '一の坂ダム' },
  { code: '014', name: '今富ダム' },
  { code: '015', name: '厚東川ダム' },
  { code: '016', name: '真締川ダム' },
  { code: '017', name: '木屋川ダム' },
  { code: '018', name: '湯免ダム' },
  { code: '019', name: '大坊ダム' },
  { code: '020', name: '見島ダム' },
  { code: '021', name: '阿武川ダム' },
  { code: '022', name: '黒杭川上流ダム' },
  { code: '023', name: '平瀬ダム' },
];

// --- parsing ----------------------------------------------------------------

/** "YYYY/MM/DD HH:MM" (JST) → UTC. */
export function parseYamaguchiTimestamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, yr, mo, dy, hh, mi] = m.map(Number) as [string, number, number, number, number, number];
  const d = new Date(Date.UTC(yr, mo - 1, dy, hh - 9, mi, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "****" (欠測), blank (未観測) and dashes are the site's own marks. */
function parseVal(s: string): Cell {
  const t = s.replace(/<[^>]+>/g, '').trim();
  if (!t || t === '-' || t === '---' || t === '****') return cell(null, true);
  return cell(Number(t.replace(/,/g, '')), false);
}

/**
 * A dam's reading from its 24-hour データ table: every on-the-hour row with a
 * value, oldest first.
 *
 * The page never closes its data <tr>s, so a row runs up to the next <tr> or
 * the end of the table body. Matching up to </tr> instead swallowed the whole
 * table into its first row and stored the reading from 24 hours earlier.
 */
export function yamaguchiReading(html: string): Reading {
  const observations: Observed[] = [];
  let hourly = 0;
  let marked = 0;
  let outage = 0;
  for (const row of html.matchAll(
    /<tr\s+class="hour_\w+\s*">([\s\S]*?)(?=<tr[\s>]|<\/tbody>|<\/table>)/gi,
  )) {
    const cells = Array.from((row[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(
      (c) => c[1] ?? '',
    );
    if (cells.length < 5) continue;

    // Timestamp cell: "YYYY/MM/DD<br />HH:MM" (also handles <br> and <br/>)
    const tsRaw = (cells[0] ?? '').replace(/<br\s*\/?>/gi, ' ').trim();
    const observedAt = parseYamaguchiTimestamp(tsRaw);
    // hour_HHb opens the window at HH:40 or so; only HH:00 is an hourly reading.
    if (observedAt?.getUTCMinutes() !== 0) continue;
    hourly += 1;

    const level = parseVal(cells[1] ?? '');
    // No reservoir here sits at EL 0 m (the lowest, 見島, holds ~19 m). The
    // page prints outages as 0.00 with every other column 0 (see deploy/ops/
    // oneoff/2026-09-28_yamaguchi_bousai_outage_zeros.sql), so the whole row
    // is a placeholder.
    if (level === 0) {
      outage += 1;
      continue;
    }
    const rate = parseVal(cells[2] ?? '');
    const inflow = parseVal(cells[3] ?? '');
    const outflow = parseVal(cells[4] ?? '');
    const state = cellState([level, rate, inflow, outflow]);
    if (state === 'empty') marked += 1;
    if (state !== 'values') continue;

    const ratePct = numberIn(rate);
    observations.push({
      observedAt,
      waterLevelM: numberIn(level),
      storageRate: ratePct !== null ? ratePct / 100 : null,
      inflowM3s: numberIn(inflow),
      outflowM3s: numberIn(outflow),
    });
  }
  if (observations.length > 0) return { state: 'values', observations };
  if (hourly === 0) return { state: 'unreadable', why: 'no hourly row in the データ table' };
  if (marked === hourly) return { state: 'empty', mark: '**** or blank in every hourly row' };
  if (outage > 0) return { state: 'unreadable', why: 'outage placeholder rows (貯水位 0.00)' };
  return { state: 'unreadable', why: 'no numeric cell' };
}

/** One entry per catalogued station; `readings` holds each station's reading by code. */
export function yamaguchiEntries(readings: ReadonlyMap<string, Reading>): Entry[] {
  return STATIONS.map(({ code, name }) => ({
    key: code,
    name,
    pref: name === '小瀬川ダム' ? KOZEGAWA_SCOPE : PREF_CODE,
    reading: readings.get(code) ?? { state: 'unreadable', why: 'not fetched' },
  }));
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Fetch all stations in parallel; a page that fails is that station's
  // unreadable reading, never a dropped entry.
  const readings = new Map<string, Reading>(
    await Promise.all(
      STATIONS.map(async ({ code }): Promise<[string, Reading]> => {
        try {
          const r = await fetch(`${BASE_URL}?stncd=${code}`, {
            headers: { 'user-agent': ua },
            signal: AbortSignal.timeout(20_000),
            redirect: 'follow',
          });
          if (r.status !== 200) {
            log(`${SOURCE_ID}: stncd=${code} HTTP ${r.status}`);
            return [code, { state: 'unreadable', why: `HTTP ${r.status}` }];
          }
          return [code, yamaguchiReading(await r.text())];
        } catch (err) {
          return [
            code,
            { state: 'unreadable', why: err instanceof Error ? err.message : String(err) },
          ];
        }
      }),
    ),
  );
  return { entries: yamaguchiEntries(readings) };
});
