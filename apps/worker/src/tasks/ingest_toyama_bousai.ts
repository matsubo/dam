// apps/worker/src/tasks/ingest_toyama_bousai.ts
//
// 富山県 河川現況表 ダム貯水位表 — 16 県管理ダム, 10-min telemetry.
//
//   室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/
//   布施川/城端/境川/大谷/久婦須川/舟川
//
// Page: https://kawa.pref.toyama.jp/camera/02condlist.html?id=0&sel=3 renders
// in the browser from two CSVs next to it (UTF-8, CRLF, no header):
//
//   data/damname_data.csv  code, ダム名, 水系名, 川の防災情報 URL, season flag,
//                          season start, season end, 貯水率 shown (1/0)
//   data/dam_data.csv      code, YYYY/MM/DD, HH:MM (JST, per dam), 貯水位 m,
//                          trend, 全流入量, 全放流量, 貯水率 利水容量 %,
//                          貯水率 有効容量 %, (unused)
//
// The page labels the two rate columns 「貯水率 利水容量(％)」 and
// 「貯水率 有効容量(％)」 and prints － for both where the shown flag is 0
// (熊野川, 朝日小川). Missing values: 貯水位 -9999.99, flows -99999.99,
// rates -99.9. Three stations' flows are not stored in m³/s; see FLOW_FIX.
//
// This replaced the Salesforce 県内ダム情報実況表 (hourly, no 貯水率): the same
// 16 dams under the same names, plus both rates and a per-dam time. Levels and
// (scaled) flows equal MLIT 川の防災情報's for the same stations and minutes.
//
// storageRate is the 利水容量 column. Checked at the 2026-09-27 16:30 JST
// update against MLIT 川の防災情報 (gjson/obs/…/dam/1601.json → tmlist/dam):
// both rate columns equal its storPcntIrr / storPcntEff on all 12 dams where
// both publish one, and its 貯水量 divided by the 利水 rate lands below the
// annual 有効 capacity — a season pool — while the 有効 column back-solves to
// the annual figure:
//
//   室牧     4,432 千m³ / 66.3 % = 6,685  (有効 13,500; ÷36.6 % = 12,109)
//   上市川     792 / 57.9 % = 1,368      (3,500)
//   上市川第二 972 / 58.6 % = 1,659      (4,700)
//   白岩川     194 / 48.2 % =   402      (1,700)
//   和田川     669 / 74.5 % =   898      (1,900)
//   境川    22,283 / 45.7 % = 48,759     (56,100)
//
// Not trusted_rate_basis anyway: this feed has no 貯水量, so
// effective_active_capacity_m3() has nothing to back-solve from it. And
// display_observation() ranks any current trusted row with a native rate
// first, newest first — these volume-less 10-minute rows would then displace
// kasenbosai's trusted rows (which carry the 貯水量) on the dam page and blank
// its 貯水量 / 貯水率.
//
// A 貯水率 on a row whose 貯水位 is 欠測 is dropped: 城端 and 利賀川 carried
// 18.8 / 15.4 % that way while MLIT flagged the same readings missing. A dam
// whose 貯水位 and flows are all at the 欠測 sentinel is provider-marked
// empty.
//
// damname_data.csv is the published list, keyed by the printed name (the
// stamp since this source started). When dam_data.csv cannot be read, every
// listed dam is unreadable.
// Priority 308.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_BASE = process.env.TOYAMA_BOUSAI_DATA_BASE ?? 'https://kawa.pref.toyama.jp/camera/data';

const PREF_CODE = '16';
const SOURCE_ID = 'toyama-bousai';

// Flow columns not stored in m³/s, converted exactly as the page's own
// scripts do before rendering (both under kawa.pref.toyama.jp/camera/contents/):
//
// - 002_header.js DamListData(): 利賀川 (0090004) and 角川 (0020007) render
//   as Math.round(v*100)/10 — 角川 0.04 → 0.40, as MLIT 川の防災情報 reads.
// - fileaccess.js DAMZenryuunyuuCalc(), run from Make_GENSUICyuiKeikai() on
//   02condlist.html: 舟川 (0030016) is rewritten to Math.floor(v*10)/100 —
//   2.11 → 0.21 at 16:30 JST on 2026-09-27, as MLIT read for the same minute.
const FLOW_FIX: Record<string, (v: number) => number> = {
  '0090004': (v) => Math.round(v * 100) / 10,
  '0020007': (v) => Math.round(v * 100) / 10,
  '0030016': (v) => Math.floor(v * 10) / 100,
};

// --- types ------------------------------------------------------------------

export interface ToyamaStation {
  code: string;
  toyamaName: string;
  /** The page prints 貯水率 for this dam (damname_data.csv column 8). */
  ratePublished: boolean;
}

// --- parsing ----------------------------------------------------------------

function csvRows(csv: string): string[][] {
  return csv
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',').map((c) => c.trim()));
}

/** A value cell: the upstream's 欠測 sentinel (or below) is its mark. */
function reading(s: string | undefined, missingAtOrBelow: number): Cell {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return cell(n, n <= missingAtOrBelow);
}

/** damname_data.csv — the provider's whole published list, in page order. */
export function parseToyamaStations(csv: string): ToyamaStation[] {
  const out: ToyamaStation[] = [];
  for (const c of csvRows(csv)) {
    const [code, toyamaName, , , , , , shown] = c;
    if (!code || !toyamaName) continue;
    out.push({ code, toyamaName, ratePublished: shown === '1' });
  }
  return out;
}

/** One dam's reading from its dam_data.csv row. */
export function toyamaReading(station: ToyamaStation, row: string[] | undefined): Reading {
  if (!row) return { state: 'unreadable', why: 'no dam_data.csv row' };
  const [, date, time, levelRaw, , inflowRaw, outflowRaw, rateIrr] = row;
  const dm = date?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const tm = time?.match(/^(\d{2}):(\d{2})$/);
  if (!dm || !tm) return { state: 'unreadable', why: `time "${date} ${time}"` };
  const observedAt = new Date(
    Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]) - 9, Number(tm[2])),
  );

  const level = reading(levelRaw, -9999.99);
  const fix = FLOW_FIX[station.code];
  const flow = (s: string | undefined): Cell => {
    const v = reading(s, -99999.99);
    return typeof v === 'number' && fix ? fix(v) : v;
  };
  const inflow = flow(inflowRaw);
  const outflow = flow(outflowRaw);
  // A rate held over a 欠測 level is not a reading, and where the page prints
  // － (shown flag 0) there is none.
  const rate: Cell[] =
    station.ratePublished && typeof level === 'number' ? [reading(rateIrr, -99.9)] : [];

  const state = cellState([level, inflow, outflow, ...rate]);
  if (state === 'empty') return { state, mark: '欠測 sentinel on 貯水位 and both flows' };
  if (state === 'unreadable') return { state, why: 'no value cell parsed' };
  const pct = rate[0] === undefined ? null : numberIn(rate[0]);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageRate: pct === null ? null : pct / 100,
      },
    ],
  };
}

/** 第N kanji numerals as the master writes them: 上市川第二 → 上市川第2. */
function arabicOrdinal(name: string): string {
  return name.replace(/第([一二三四五])/g, (_m, k: string) => `第${'一二三四五'.indexOf(k) + 1}`);
}

/**
 * Every published dam, read from dam_data.csv joined by code (an Error when
 * the CSV could not be read). A data row whose code is not on the list is not
 * published.
 */
export function toyamaEntries(stations: ToyamaStation[], dataCsv: string | Error): Entry[] {
  const rowByCode = new Map(
    dataCsv instanceof Error ? [] : csvRows(dataCsv).map((c) => [c[0], c] as const),
  );
  return stations.map((s): Entry => {
    const bindName = arabicOrdinal(s.toyamaName);
    return {
      key: s.toyamaName,
      name: s.toyamaName,
      pref: PREF_CODE,
      ...(bindName !== s.toyamaName ? { bind: { name: bindName } } : {}),
      reading:
        dataCsv instanceof Error
          ? { state: 'unreadable', why: dataCsv.message }
          : toyamaReading(s, rowByCode.get(s.code)),
    };
  });
}

// --- task -------------------------------------------------------------------

async function fetchCsv(file: string): Promise<string> {
  const r = await fetch(`${DATA_BASE}/${file}`, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${file} HTTP ${r.status}`);
  return r.text();
}

export default ingestTask(SOURCE_ID, async (log) => {
  const stations = parseToyamaStations(await fetchCsv('damname_data.csv'));
  const dataCsv = await fetchCsv('dam_data.csv').catch((err: unknown) =>
    err instanceof Error ? err : new Error(String(err)),
  );
  if (dataCsv instanceof Error) log(`${SOURCE_ID}: ${dataCsv.message}`);
  log(`${SOURCE_ID}: ${stations.length} published dams`);
  return { entries: toyamaEntries(stations, dataCsv) };
});
