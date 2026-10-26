// apps/worker/src/tasks/ingest_nagano_kigyo.ts
//
// 長野県企業局 ダム情報 — the 企業局's own 10分諸量 for its generating dams.
//
//   高遠ダム (天竜川水系三峰川; 発電・かんがい) — kasenbosai rows are all NULL
//   菅平ダム (信濃川水系神川; かんがい・発電・上水道) — no other live source
//
// Source: https://naganoken-kigyokyoku.jp/dam/ loads, per dam,
//   https://naganoken-kigyokyoku.jp/json/{takato,sugadaira}_new.json
// ({"table":[…]}, the four newest 10-minute rows, newest first), rewritten
// 12–34 s after every 10-minute mark. robots.txt disallows only
// /wp/wp-admin/. The page's third dam, 湯の瀬, has a camera image and no
// figures, so it is not part of the published universe.
//
// Keys differ per dam (the page's own dam_data_new.js maps them):
//   高遠   v_reservoirlevel10 (EL.m) · v_totalinflow1 (old name v_totalinflow11)
//          · v_totaldischarge11
//   菅平   v_reservoirlevel13 (EL.m) · v_totalinflow11 · v_totaldischarge11
//          · v_chor 貯水率 (%)
// v_reservoirlevel1 / v_reservoirlevel7 are gauge heights (9.26 / 15.31 m)
// and are not read. Cells are strings; "欠測" / "未実装" are the 企業局's own
// marks (null; a dam marked on every cell is provider-marked empty).
//
// Rows carry "HH:MM" only. The date comes from the file's Last-Modified
// header, which the server sets when it rewrites the file (12:40:33 GMT for
// a newest row of 21:40 JST in the fixture): the newest row is the latest
// HH:MM at or before that instant, and each older row steps back across
// midnight when its clock time is not earlier than the row before it. A file
// that stops being rewritten keeps its old Last-Modified, so a stale feed
// re-upserts the same old rows instead of stamping them with today's date.
// No Last-Modified → the dam is unreadable.
//
// Rate: 菅平's v_chor is stored as a fraction but NOT trusted — the feed
// publishes no 貯水量, so the denominator cannot be back-solved per 0048.
//
// Priority 311, above kasenbosai (310). kasenbosai's 高遠 station (stamp
// 2183100700009) has never carried a volume (0 of 3,199 prod rows) and its
// last non-NULL value is 2026-07-03 05:50 UTC — 2,014 all-NULL rows since
// 07-06 as of 2026-09-27 — yet it keeps writing hourly rows, and
// preferredSourceForDam() picks the top-priority source with ANY row, so
// below it 高遠's chart stays empty. 311 is shared only by tochigi-bodik /
// hyogo-bodik, which never cover 長野. Alone on 菅平.
//
// Cron at :24 and :54. Four rows span 30 minutes, so one run an hour keeps
// only four of the six rows. The :24 run sees :20/:10/:00/:50 (the :20
// rewrite has landed, the :30 one has not), and the :54 run sees
// :50/:40/:30/:20. Together they cover every 10-minute row; :20 and :50 are
// read twice, and the upsert rewrites them with the same values.

import { type Cell, cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.NAGANO_KIGYO_JSON_BASE ?? 'https://naganoken-kigyokyoku.jp/json';

const PREF_CODE = '20';
const SOURCE_ID = 'nagano-kigyo';

export interface DamCfg {
  /** JSON file stem; also the stamp and universe key. */
  key: string;
  /** Name as the 企業局 page prints it. */
  name: string;
  level: string;
  /** Current key first, then the older name the page falls back to. */
  inflow: readonly string[];
  outflow: string;
  rate: string | null;
}

export const DAMS: readonly DamCfg[] = [
  {
    key: 'takato',
    name: '高遠ダム',
    level: 'v_reservoirlevel10',
    inflow: ['v_totalinflow1', 'v_totalinflow11'],
    outflow: 'v_totaldischarge11',
    rate: null,
  },
  {
    key: 'sugadaira',
    name: '菅平ダム',
    level: 'v_reservoirlevel13',
    inflow: ['v_totalinflow11'],
    outflow: 'v_totaldischarge11',
    rate: 'v_chor',
  },
];

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: Cell;
  inflowM3s: Cell;
  outflowM3s: Cell;
  /** 貯水率 in percent; absent for a dam that publishes none. */
  ratePct?: Cell;
}

const JST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/** A string cell: a number, the 企業局's 欠測 / 未実装 mark, or unreadable. */
function field(v: string | null | undefined): Cell {
  const t = v?.trim() ?? '';
  const n = t === '' ? null : Number(t);
  return cell(n, t === '欠測' || t === '未実装');
}

/**
 * The table's rows with dates reconstructed from `lastModified` (see header).
 * Rows without a parsable "HH:MM" are dropped.
 */
export function parseNaganoKigyoTable(json: string, cfg: DamCfg, lastModified: Date): ParsedRow[] {
  const table = (JSON.parse(json) as { table?: Record<string, string | null>[] }).table ?? [];

  const rows: ParsedRow[] = [];
  // The newest row may sit exactly at Last-Modified; each older row must be
  // strictly earlier than the one before it.
  let ceiling = lastModified.getTime();
  let inclusive = true;
  for (const r of table) {
    const t = (r.v_time ?? '').match(/^(\d{1,2}):(\d{2})$/);
    if (!t) continue;
    const ceilingJst = ceiling + JST_MS;
    const jstMidnight = ceilingJst - (ceilingJst % DAY_MS) - JST_MS;
    let at = jstMidnight + (Number(t[1]) * 60 + Number(t[2])) * 60_000;
    if (inclusive ? at > ceiling : at >= ceiling) at -= DAY_MS;
    ceiling = at;
    inclusive = false;

    const inflowKey = cfg.inflow.find((k) => r[k] !== undefined);
    rows.push({
      observedAt: new Date(at),
      waterLevelM: field(r[cfg.level]),
      inflowM3s: inflowKey === undefined ? null : field(r[inflowKey]),
      outflowM3s: field(r[cfg.outflow]),
      ...(cfg.rate === null ? {} : { ratePct: field(r[cfg.rate]) }),
    });
  }
  return rows;
}

/** One dam's file: its rows, or the 企業局's marks on every cell. */
export function naganoReading(json: string, cfg: DamCfg, lastModified: Date): Reading {
  const rows = parseNaganoKigyoTable(json, cfg, lastModified);
  const cells: Cell[] = [];
  for (const r of rows) {
    cells.push(r.waterLevelM, r.inflowM3s, r.outflowM3s);
    if (r.ratePct !== undefined) cells.push(r.ratePct);
  }
  const state = cellState(cells);
  if (state === 'empty') return { state, mark: '欠測 / 未実装 on every cell' };
  if (state === 'unreadable') return { state, why: `no value in ${rows.length} rows` };
  return {
    state,
    observations: rows.map((r) => {
      const pct = r.ratePct === undefined ? null : numberIn(r.ratePct);
      return {
        observedAt: r.observedAt,
        waterLevelM: numberIn(r.waterLevelM),
        inflowM3s: numberIn(r.inflowM3s),
        outflowM3s: numberIn(r.outflowM3s),
        storageRate: pct === null ? null : pct / 100,
      };
    }),
  };
}

// --- entries ----------------------------------------------------------------

/** A dam's file as served: its body and Last-Modified header. */
export type FetchFile = (url: string) => Promise<{ body: string; lastModified: string | null }>;

/**
 * Both dams, known in advance; each reads its own file. Binds only the master
 * of the same name (the live twin of a （元）/（再） pair).
 */
export function naganoKigyoEntries(fetchFile: FetchFile): Entry[] {
  return DAMS.map((cfg) => ({
    key: cfg.key,
    name: cfg.name,
    pref: PREF_CODE,
    bind: { exact: true },
    reading: async () => {
      const { body, lastModified } = await fetchFile(`${BASE_URL}/${cfg.key}_new.json`);
      const at = new Date(lastModified ?? '');
      if (Number.isNaN(at.getTime())) throw new Error('no Last-Modified; cannot date its rows');
      return naganoReading(body, cfg, at);
    },
  }));
}

const fetchFile: FetchFile = async (url) => {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} for ${url}`);
  return { body: await r.text(), lastModified: r.headers.get('last-modified') };
};

export default ingestTask(SOURCE_ID, async () => ({ entries: naganoKigyoEntries(fetchFile) }));
