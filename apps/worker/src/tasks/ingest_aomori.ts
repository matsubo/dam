// apps/worker/src/tasks/ingest_aomori.ts
//
// Eighth real-observation source. 青森県河川砂防情報提供システム
// (kasensabo.bousai.pref.aomori.jp) publishes a per-dam ダム諸量グラフ page
// with a 10-minute table. The dams come from its ダム諸量現況表, which lists
// every dam the system carries with the 局番号 its graph link passes to
// damGraph() — 11 on 2026-09-27:
//
//   下湯, 久吉, 浅瀬石川 (国), 世増, 浅虫, 遠部, 津軽 (国), 飯詰, 小泊,
//   清水目, 川内
//
// List:  servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1
// Graph: servletBousaiContents?style=dam_graph10m&dk=4&it=0&sn={局番号}&nw=1
// Both Shift_JIS HTML. The graph table's header row reads, in order:
//   時分 | ダム地点 10分[mm] 累加[mm] | 流入量[m³/s] | 全放流量[m³/s] |
//   貯水位[EL.m] | 貯水量(有効容量)[1000m³] | 貯水率(有効容量)[%] |
//   貯水率(利水容量)[%]
//
// and each data row is <th class="title time">HH:MM</th> + 8 <td> cells.
// "---" = 無効/閉局/保守, "***" = 欠測, empty = 未受信. The page shows a
// 4-hour window; the date header above it is the window's END date, so rows
// before a midnight wrap belong to the previous day.
//
// 貯水率: prefer 利水容量. Back-solving the live page (2026-09-27) shows 有効
// is the annual 有効貯水容量 (下湯 2,111/0.192 = 10,995 千m³ vs master
// 11,000; 久吉 6,070 vs 6,070; 浅虫 170 vs 170; 世増 33,066 vs 33,100; 飯詰
// 2,007 vs 2,030; 小泊 340 vs 340; 川内 14,500 vs 14,500), while 利水 divides
// by a smaller, season-aware pool (津軽 42,561/0.578 = 73,635 vs annual
// 127,200; 川内 5,000 vs 14,500; 飯詰 747 vs 2,030; 世増 reads 100 % at its
// 洪水貯留準備水位, 3 m below 平常時最高水位). 治水-only dams (遠部, 清水目)
// print "---" for 利水; for those we fall back to the 有効 rate, which is
// volume / annual 有効 — the same figure the site would derive from the
// static capacity, so back-solving it is an identity.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const SOURCE_ID = 'aomori-dam';
const BASE_URL =
  process.env.AOMORI_DAM_BASE_URL ?? 'https://www.kasensabo.bousai.pref.aomori.jp/bousai/servlet';
const LIST_URL = `${BASE_URL}/bousaiweb.servletBousaiTableStatus?sv=3&dk=4&mp=0&no=0&fn=0&pg=1`;
const GRAPH_URL = `${BASE_URL}/bousaiweb.servletBousaiContents`;

export interface DamCfg {
  /** Name as the list prints it, "(国)" dropped; the station stamp. */
  aomoriName: string;
  /** 局番号 (sn) of the dam's ダム諸量グラフ page. */
  stationNo: number;
}

const PREF_CODE = '02';

/** Every dam the ダム諸量現況表 lists, in page order. */
export function parseAomoriDamList(html: string): DamCfg[] {
  return [...html.matchAll(/onClick="myIn\('(\d+)','[^']*','[^']*'\)">([^<]+)</gi)].map((m) => ({
    aomoriName: (m[2] ?? '').replace(/\(国\)$/, '').trim(),
    stationNo: Number(m[1]),
  }));
}

export interface AomoriRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  /** Fraction (1.0 = 100 %): 利水容量 basis, 有効容量 when 利水 is blank. */
  storageRate: number | null;
}

/** "---" (無効/閉局/保守) and "***" (欠測) are the page's marks; empty is 未受信. */
function valueCell(s: string): Cell {
  const t = s.replace(/&nbsp;/g, '').trim();
  if (t === '---' || t === '***') return MARKED;
  return cell(t ? Number(t) : null, false);
}

// Guards the positional cell mapping below: if the provider reorders or
// renames the volume / rate columns we must not store one as the other.
const HEADER_RE =
  /流入量<br>[\s\S]*?全放流量<br>[\s\S]*?貯水位<br>[\s\S]*?貯水量<br>\(有効容量\)[\s\S]*?貯水率<br>\(有効容量\)[\s\S]*?貯水率<br>\(利水容量\)/;

const ROW_RE =
  /<th[^>]*class="title time"[^>]*>(\d{2}):(\d{2})[^<]*<\/th>((?:\s*<td[^>]*>[^<]*<\/td>){8})/g;

interface GraphRow {
  observedAt: Date;
  /** [0] 流入量 [1] 全放流量 [2] 貯水位 [3] 貯水量(有効) 千m³ [4] 貯水率(有効) % [5] 貯水率(利水) % */
  cells: Cell[];
}

/** Every dated row of one ダム諸量グラフ (10分) page; null unless the layout is the known one. */
function parseGraphRows(html: string): GraphRow[] | null {
  const dm = html.match(/class="date">(\d{4})年(\d{1,2})月(\d{1,2})日</);
  if (!dm || !HEADER_RE.test(html)) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];

  const raw: { minutes: number; cells: string[] }[] = [];
  for (const m of html.matchAll(ROW_RE)) {
    const cells = [...(m[3] ?? '').matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((c) => c[1] ?? '');
    raw.push({ minutes: Number(m[1]) * 60 + Number(m[2]), cells });
  }

  // The last row sits on the header date; walk backwards and step back a day
  // each time the clock wraps.
  const dayOffset: number[] = new Array(raw.length).fill(0);
  for (let i = raw.length - 2; i >= 0; i--) {
    const next = raw[i + 1];
    const cur = raw[i];
    if (!cur || !next) continue;
    dayOffset[i] = (dayOffset[i + 1] ?? 0) - (cur.minutes > next.minutes ? 1 : 0);
  }

  return raw.map((r, i) => ({
    observedAt: new Date(
      Date.UTC(y, mo - 1, d + (dayOffset[i] ?? 0), Math.floor(r.minutes / 60) - 9, r.minutes % 60),
    ),
    // cells: [0] 10分雨量 [1] 累加雨量 [2] 流入量 [3] 全放流量 [4] 貯水位
    //        [5] 貯水量(有効) 千m³ [6] 貯水率(有効) % [7] 貯水率(利水) %
    cells: r.cells.slice(2, 8).map(valueCell),
  }));
}

function toRow({ observedAt, cells }: GraphRow): AomoriRow {
  const [inflow, outflow, level, volume, rateEffective, rateWaterUse] = cells.map(numberIn);
  const ratePct = rateWaterUse ?? rateEffective ?? null;
  return {
    observedAt,
    waterLevelM: level ?? null,
    inflowM3s: inflow ?? null,
    outflowM3s: outflow ?? null,
    storageVolumeM3: volume != null ? volume * 1_000 : null,
    storageRate: ratePct !== null ? ratePct / 100 : null,
  };
}

/** Parse one ダム諸量グラフ (10分) page into dated rows that carry dam data. */
export function parseAomoriDamGraph(html: string): AomoriRow[] {
  return (parseGraphRows(html) ?? []).filter((r) => cellState(r.cells) === 'values').map(toRow);
}

/** A dam's reading: the page's latest row that carries dam data. */
export function aomoriReading(html: string): Reading {
  const rows = parseGraphRows(html);
  if (!rows) return { state: 'unreadable', why: 'not the ダム諸量グラフ layout' };
  const state = cellState(rows.flatMap((r) => r.cells));
  if (state === 'empty') return { state, mark: '"---" / "***" in every dam column' };
  if (state === 'unreadable') return { state, why: 'no dam value in the window' };
  const latest = rows.filter((r) => cellState(r.cells) === 'values').at(-1);
  if (!latest) return { state: 'unreadable', why: 'no dam value in the window' };
  return { state, observations: [toRow(latest)] };
}

const headers = {
  'user-agent':
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
};

async function fetchShiftJis(url: string): Promise<string> {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

/** One dam's graph page, by 局番号. */
export type GraphFetcher = (stationNo: number) => Promise<string>;

const fetchGraph: GraphFetcher = (sn) =>
  fetchShiftJis(`${GRAPH_URL}?style=dam_graph10m&dk=4&it=0&sn=${sn}&nw=1`);

/**
 * Every listed dam; each reads its own page once the run has bound it, and a
 * page that fails leaves only that dam unreadable.
 */
export function aomoriEntries(dams: DamCfg[], graph: GraphFetcher = fetchGraph): Entry[] {
  return dams.map((c) => ({
    key: c.aomoriName,
    name: c.aomoriName,
    pref: PREF_CODE,
    reading: async () => aomoriReading(await graph(c.stationNo)),
  }));
}

export default ingestTask(SOURCE_ID, async (log) => {
  const dams = parseAomoriDamList(await fetchShiftJis(LIST_URL));
  if (dams.length === 0) throw new Error(`${SOURCE_ID}: ダム諸量現況表 lists no dams`);
  log(`${SOURCE_ID}: ${dams.length} dams listed`);
  return { entries: aomoriEntries(dams) };
});
