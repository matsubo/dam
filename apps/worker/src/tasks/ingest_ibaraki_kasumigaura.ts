// apps/worker/src/tasks/ingest_ibaraki_kasumigaura.ts
//
// 茨城県河川情報 — 霞ヶ浦 出島 水位 as the lake level of 霞ヶ浦開発 (NDI 597).
//
// 霞ヶ浦開発 is the lake itself: JWA stores 6億1,700万m³ between Y.P.±0.00 m
// and Y.P.+2.85 m (water.go.jp/kanto/kasumiga/raihou/shiru/development_project.html),
// so the lake level is the reservoir level. No live source publishes it outside
// 川の防災情報 (tool-banned); mudam's daily Y.P. series ends 2024-12-30. JWA's
// 霞ヶ浦用水管理所 (water.go.jp/kanto/kasumiy/) links 出島 as
// 「霞ヶ浦の水位状況(霞ヶ浦用水の取水地点：出島)」, and 茨城県 republishes that
// 霞ヶ浦河川事務所 station without the ban:
//
//   http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_372_1.html
//
// Shift_JIS 水位グラフ page: header 「YYYY年 MM月DD日 HH：MM 現在」, a station table
// (水系 | 河川 | 観測所名 | … | 零点高 「T.P.-0.96m」 | 雨量観測所), then 23 hourly
// rows and the latest 10-minute reading last (24 rows). Only a row that
// starts a date prints 「MM/DD  HH:MM」; 24:00 closes the day.
//
// The values are gauge heights. 「本システムでは、零点をT.P.(東京湾平均海面)で表記
// しています。Y.P.（利根川水系）=T.P.+0.8402m」 (the system's own 注意事項), and
// JWA and mudam quote the lake on Y.P., so the stored level is
// reading + 零点高 + 0.8402 m (1.51 → Y.P. 1.390 on 2026-09-28 15:50), in line
// with mudam's 2024 range of Y.P. 0.93–1.43 m. The 零点高 is read from each
// page; a page without it is refused. 出島 is one shore station, not
// 霞ヶ浦河川事務所's 湖内平均水位 (published on 川の防災情報 only).
//
// The page's 時間/累加 雨量 belong to the 霞ヶ浦庁舎 rain gauge, not the lake,
// and are not stored. No volume or rate is published.
//
// Priority 308 (prefectural 防災 tier, like ibaraki-bousai); only mudam (280,
// historical) also carries this dam. Cron hourly at :13, all 24 rows re-upserted.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL =
  process.env.IBARAKI_KASUMIGAURA_URL ??
  'http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_372_1.html';

const SOURCE_ID = 'ibaraki-kasumigaura';
const PREF_CODE = '08';
/** The 茨城県 system's station number for 出島 (gra_river_372). */
const STATION_ID = '372';
const STATION = '出島';
const MASTER_NAME = '霞ヶ浦開発';
/** Y.P. (利根川水系) = T.P. + 0.8402 m, as the 茨城県 system states it. */
const YP_OVER_TP_M = 0.8402;

export interface DejimaGraph {
  /** 零点高 on T.P., as printed. */
  zeroTpM: number;
  /** Oldest first; level on Y.P. (m). */
  readings: { observedAt: Date; waterLevelM: number }[];
}

/** Parse the 出島 水位グラフ page; null unless it is 出島 with a 零点高. */
export function parseDejimaGraph(html: string): DejimaGraph | null {
  const head = html.match(/(\d{4})年(?:&nbsp;|\s)*(\d{2})月(\d{2})日/);
  const zero = html.match(/<td>T\.P\.([+-]?\d+(?:\.\d+)?)m(?:&nbsp;)*<\/td>/);
  if (!head || !zero || !html.includes(`<td>${STATION}</td>`)) return null;
  const headYear = Number(head[1]);
  const headMonth = Number(head[2]);
  const zeroTpM = Number(zero[1]);

  const readings: DejimaGraph['readings'] = [];
  let month = 0;
  let day = 0;
  for (const m of html.matchAll(
    /class="tblColor\d r1">((?:\d{2}\/\d{2}(?:&nbsp;)+)?)(\d{2}):(\d{2})<\/td><td nowrap="" class="r2">([^<]*)<\/td>/g,
  )) {
    const date = (m[1] ?? '').match(/(\d{2})\/(\d{2})/);
    if (date) {
      month = Number(date[1]);
      day = Number(date[2]);
    }
    if (month === 0) continue;
    const gauge = (m[4] ?? '').replace(/&nbsp;/g, '').trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(gauge)) continue;
    // A December row on a January page is last year's.
    const year = month > headMonth ? headYear - 1 : headYear;
    // Date.UTC rolls 24:00 over to the next day.
    const observedAt = new Date(Date.UTC(year, month - 1, day, Number(m[2]) - 9, Number(m[3])));
    const yp = Number(gauge) + zeroTpM + YP_OVER_TP_M;
    readings.push({ observedAt, waterLevelM: Math.round(yp * 1000) / 1000 });
  }
  return { zeroTpM, readings };
}

/** The page's reading: every row that carries a gauge reading. */
export function dejimaReading(html: string): Reading {
  const graph = parseDejimaGraph(html);
  if (!graph) {
    return {
      state: 'unreadable',
      why: 'page is not the 出島 graph with a 零点高; layout changed?',
    };
  }
  if (graph.readings.length === 0) return { state: 'unreadable', why: 'no numeric gauge row' };
  return { state: 'values', observations: graph.readings };
}

/**
 * The one station this source reads, published whether or not this run's
 * page loads. It binds to the master by its exact name, not the station's.
 */
export function kasumigauraEntry(reading: Reading): Entry {
  return {
    key: STATION_ID,
    name: `${STATION}（霞ヶ浦）`,
    pref: PREF_CODE,
    bind: { name: MASTER_NAME, exact: true },
    reading,
  };
}

export default ingestTask(SOURCE_ID, async (log) => {
  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'user-agent': ua },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const html = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
    return { entries: [kasumigauraEntry(dejimaReading(html))] };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return { entries: [kasumigauraEntry({ state: 'unreadable', why })] };
  }
});
