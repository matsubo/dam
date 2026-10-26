// apps/worker/src/tasks/ingest_hkd_mlit.ts
//
// Ninth real-observation source. 国土交通省 北海道開発局 publishes a
// realtime dashboard for the 18 dams it directly manages on the
// 札幌/旭川/室蘭/小樽/網走/釧路/帯広/留萌/稚内/函館 sub-bureaus:
//   info-dam.hdb.hkd.mlit.go.jp/dam/dam_{slug}.htm
//
// Per-page layout (UTF-8 HTML):
//   summary block: 貯水量 NN千m³ / 貯水率 NN.N% / 雨量 / 流入量 / 放流量
//   hourly table (10-min cadence; last 24 h):
//     年/月/日 時:分 | 貯水位(m) | 全流入量(m³/s) | 全放流量(m³/s) | ...
//
// We pick the LATEST row of the hourly table (storing 10-min freshness)
// plus the summary 貯水量/貯水率 for that same timestamp. 「*表記は、該当する
// 数値が無いこと意味しています」: a "*" cell (and 欠測 / "-") is the bureau's
// own mark, so a dam whose every stored field carries one is provider-marked
// empty. A page per dam: one that fails to load leaves that dam unreadable.

import { type Cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const BASE_URL = process.env.HKD_MLIT_DAM_BASE ?? 'https://info-dam.hdb.hkd.mlit.go.jp/dam';

interface DamCfg {
  slug: string;
  /** Name as it appears in the page's <title> (with か, etc., as-is). */
  pageName: string;
}

const DAMS: DamCfg[] = [
  { slug: 'biratori_dam', pageName: '平取ダム' },
  { slug: 'chubetsu', pageName: '忠別ダム' },
  { slug: 'houheikyou', pageName: '豊平峡ダム' },
  { slug: 'iwaonai', pageName: '岩尾内ダム' },
  { slug: 'izarigawa', pageName: '漁川ダム' },
  { slug: 'jyouzankei', pageName: '定山渓ダム' },
  { slug: 'kanayama', pageName: '金山ダム' },
  { slug: 'kanoko', pageName: '鹿ノ子ダム' },
  { slug: 'katsurazawa', pageName: '新桂沢ダム' },
  { slug: 'nibutani', pageName: '二風谷ダム' },
  { slug: 'pirika', pageName: '美利河ダム' },
  { slug: 'rumoi', pageName: '留萌ダム' },
  { slug: 'sanru', pageName: 'サンルダム' },
  { slug: 'satsunaigawa', pageName: '札内川ダム' },
  { slug: 'taisetsu', pageName: '大雪ダム' },
  { slug: 'takisato', pageName: '滝里ダム' },
  { slug: 'tokachi', pageName: '十勝ダム' },
  { slug: 'yuubari', pageName: '夕張シューパロダム' },
];

const PREF_CODE = '01';
const SOURCE_ID = 'hkd-mlit-dam';

function parseCell(s: string | undefined): Cell {
  const raw = (s ?? '').replace(/<[^>]+>/g, '').replace(/[,\s　]/g, '');
  if (/^(?:\*+|欠測|-|―)$/.test(raw)) return MARKED;
  const t = raw.replace(/\*/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse "26/05/18　10:10" (Reiwa-style 2-digit year, JST) → UTC Date. */
export function parseHkdTimestamp(raw: string): Date | null {
  const m = raw.match(/(\d{2})\/(\d{1,2})\/(\d{1,2})[　 ]+(\d{1,2}):(\d{1,2})/);
  if (!m) return null;
  const yy = Number(m[1]);
  // The page uses 2-digit year that maps to 20YY (e.g. 26 = 2026).
  const yyyy = 2000 + yy;
  return new Date(
    Date.UTC(yyyy, Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** Read a single dam page (already UTF-8 decoded). */
export function hkdReading(html: string): Reading {
  // The hourly table has rows of 7 columns:
  //   [年/月/日 時:分, 貯水位, 全流入量, 全放流量, ゲート, 発電, 利水]
  // We want the last row (most recent timestamp).
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1] ?? '');
  let observedAt: Date | null = null;
  let level: Cell = null;
  let inflow: Cell = null;
  let outflow: Cell = null;
  // Walk forward to the last timestamp-shaped cell.
  for (let i = 0; i < cells.length; i++) {
    const ts = parseHkdTimestamp(cells[i] ?? '');
    if (ts && cells.length >= i + 4) {
      observedAt = ts;
      level = parseCell(cells[i + 1]);
      inflow = parseCell(cells[i + 2]);
      outflow = parseCell(cells[i + 3]);
    }
  }
  if (!observedAt) return { state: 'unreadable', why: 'no timestamped row' };

  // Summary fields (top of page). Storage values:
  //   貯水量　96501千m<sup>3</sup>
  //   貯水率　74.2%
  //   雨量　0.0mm/h
  const storageMatch = html.match(/貯水量[\s　]*([\d,.*-]+|欠測|―)千m/);
  const rateMatch = html.match(/貯水率[\s　]*([\d.*-]+|欠測|―)%/);
  const rainMatch = html.match(/雨量[\s　]*([\d.*-]+|欠測|―)mm\/h/);
  const storageThou = storageMatch ? parseCell(storageMatch[1]) : null;
  const ratePct = rateMatch ? parseCell(rateMatch[1]) : null;
  const rain = rainMatch ? parseCell(rainMatch[1]) : null;

  const state = cellState([level, inflow, outflow, storageThou, ratePct, rain]);
  if (state === 'empty') return { state, mark: '* in every field' };
  if (state === 'unreadable') return { state, why: 'no numeric field' };
  const thou = numberIn(storageThou);
  const pct = numberIn(ratePct);
  return {
    state: 'values',
    observations: [
      {
        observedAt,
        waterLevelM: numberIn(level),
        inflowM3s: numberIn(inflow),
        outflowM3s: numberIn(outflow),
        storageVolumeM3: thou != null ? thou * 1000 : null,
        storageRate: pct != null ? pct / 100 : null,
        rainfallMm: numberIn(rain),
      },
    ],
  };
}

/** The 18 dams, each read from its own page once the run reaches it. */
export function hkdEntries(fetchPage: (url: string) => Promise<string>): Entry[] {
  return DAMS.map((c) => ({
    key: c.slug,
    name: c.pageName,
    pref: PREF_CODE,
    reading: async () => hkdReading(await fetchPage(`${BASE_URL}/dam_${c.slug}.htm`)),
  }));
}

async function fetchPage(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export default ingestTask(SOURCE_ID, async () => ({ entries: hkdEntries(fetchPage) }));
