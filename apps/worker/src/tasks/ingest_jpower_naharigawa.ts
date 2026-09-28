// apps/worker/src/tasks/ingest_jpower_naharigawa.ts
//
// 電源開発 (J-POWER) 奈半利川ダム情報公開サイト — the three 発電 dams on the
// 奈半利川 (高知/39): 魚梁瀬, 久木, 平鍋. No prefectural, MLIT or other feed
// carries them (kochi-bousai's ダム諸量現況表 lists 11 other dams).
//
// Source: one ダムグラフ page per dam (UTF-8 HTML, ASP.NET, plain GET):
//   https://jpower-naharigawa-daminfo.jp/Pages/DamGraph01.aspx
//     ?value=YYYY/MM/DD HH:00&no=<71100|71200|71300>
// `no` comes from the site's Scripts/Project/Suibou.js (OpenDamGraph01..03);
// the three dams are the whole list its main.aspx links. Without `value` the
// page is an empty template; with it, the 観測データ table holds the 12
// half-hour columns ending at that JST hour (the page writes midnight as
// 24:00 of the day before; a not-yet-observed column is blank). The table
// prints only MM/DD, so each column is dated from the page's own selected
// x_year / x_month / x_day — never from the requested value, which the
// server silently clamps (a 2099 request shows 2026 data).
//
// Rows stored: 貯水位 (EL.m) → water level, 全流入量 / 全放流量 (m³/s) → flows.
// 全流入量 is back-calculated and published negative at times (-11.00);
// kept as published. Not stored: 時間 / 累計 雨量, which the page says are the
// mean of three basin gauges, not the dam site. No volume or rate is
// published. A column with no level, inflow or outflow is dropped.
//
// Licence: the site states no terms and no copyright line.
//
// Priority 301, the operator tier of mc-tottori-hydro; no other source covers
// these dams. Cron hourly at :48, asking for the hour now running so its :00
// and :30 columns are both read; the 6-hour window re-covers missed runs.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import {
  recordUniverse,
  recordUniverseHasData,
  type UniverseRow,
} from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.JPOWER_NAHARIGAWA_URL ?? 'https://jpower-naharigawa-daminfo.jp/Pages/DamGraph01.aspx';

const PREF_CODE = '39';
const SOURCE_ID = 'jpower-naharigawa';

/** The site's whole dam list; `name` is what each page prints in x_name. */
const STATIONS = [
  { no: '71100', name: '魚梁瀬ダム' },
  { no: '71200', name: '久木ダム' },
  { no: '71300', name: '平鍋ダム' },
] as const;

// --- parsing ----------------------------------------------------------------

export interface NaharigawaReading {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

export interface NaharigawaGraph {
  /** The dam name the page prints (x_name); null on an empty page. */
  name: string | null;
  readings: NaharigawaReading[];
}

function cells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
    (c[1] ?? '')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .trim(),
  );
}

function selected(html: string, name: string): number | null {
  const select = html.match(new RegExp(`<select name="${name}"[\\s\\S]*?</select>`));
  const opt = select?.[0].match(/<option selected="selected" value="(\d+)/);
  return opt ? Number(opt[1]) : null;
}

function num(text: string | undefined): number | null {
  return text !== undefined && /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null;
}

export function parseNaharigawaGraph(html: string): NaharigawaGraph {
  const rows = new Map<string, string[]>();
  for (const tr of html.matchAll(/<tr id="x_row\d+">([\s\S]*?)<\/tr>/g)) {
    const [label, ...rest] = cells(tr[1] ?? '');
    if (label !== undefined) rows.set(label, rest);
  }
  const header = html.match(/<tr id="x_row0">([\s\S]*?)<\/tr>/)?.[1] ?? '';
  const year = selected(html, 'x_year');
  const endMonth = selected(html, 'x_month');
  const endDay = selected(html, 'x_day');
  const times = rows.get('時 ： 分');
  // A non-browser user agent gets ASP.NET's downlevel markup, which wraps
  // the name in <font><b>; the values rows differ only in attributes.
  const nameCell = html.match(/<td id="x_name"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '';
  const name = nameCell.replace(/<[^>]*>/g, '').trim() || null;
  if (year === null || endMonth === null || endDay === null || !times) {
    return { name: null, readings: [] };
  }

  // Row 0 spans each MM/DD over its columns; the last column is headed 最新
  // and is the page's selected (final) date.
  const dates: [number, number][] = [];
  for (const th of header.matchAll(/<td([^>]*)>([^<]*)<\/td>/g)) {
    const md = (th[2] ?? '').match(/^(\d{2})\/(\d{2})$/);
    const span = Number((th[1] ?? '').match(/colspan="(\d+)"/)?.[1] ?? 1);
    if (md) for (let i = 0; i < span; i++) dates.push([Number(md[1]), Number(md[2])]);
    else if (th[2] === '最新') dates.push([endMonth, endDay]);
  }

  const level = rows.get('貯水位') ?? [];
  const inflow = rows.get('全流入量') ?? [];
  const outflow = rows.get('全放流量') ?? [];
  const readings: NaharigawaReading[] = [];
  times.forEach((time, i) => {
    const date = dates[i];
    const hm = time.match(/^(\d{2}):(\d{2})$/);
    if (!date || !hm) return;
    const waterLevelM = num(level[i]);
    const inflowM3s = num(inflow[i]);
    const outflowM3s = num(outflow[i]);
    if (waterLevelM === null && inflowM3s === null && outflowM3s === null) return;
    const [month, day] = date;
    // A December column on a January page belongs to the year before; 24:00
    // rolls over to the next day's 00:00 in Date.UTC.
    const y = month > endMonth ? year - 1 : year;
    readings.push({
      observedAt: new Date(Date.UTC(y, month - 1, day, Number(hm[1]) - 9, Number(hm[2]))),
      waterLevelM,
      inflowM3s,
      outflowM3s,
    });
  });
  return { name, readings };
}

/**
 * The page's `value` for the JST hour now running ("YYYY/MM/DD HH:00", hours
 * 01–24, midnight as 24:00 of the day before).
 */
export function graphValue(now: Date): string {
  const hourMs = 3_600_000;
  const end = new Date(Math.ceil(now.getTime() / hourMs) * hourMs + 9 * hourMs);
  // 00:00 JST is written 24:00 of the previous day.
  const day = new Date(end.getTime() - (end.getUTCHours() === 0 ? hourMs * 24 : 0));
  const hour = end.getUTCHours() === 0 ? 24 : end.getUTCHours();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${day.getUTCFullYear()}/${p(day.getUTCMonth() + 1)}/${p(day.getUTCDate())} ${p(hour)}:00`;
}

// --- matching ---------------------------------------------------------------

function stem(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * The master row for a published dam name: the row stamped with it, else an
 * exact stem match, a （元）/（再） pair settled by preferMaster. No prefix
 * fallback: a 久木 must not land on some 久木野.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const target = stem(name);
  const candidates = masters
    .filter((m) => m.stamp === name || stem(m.name) === target)
    .map((m) => ({ ...m, rank: 0 }));
  return chooseRanked(candidates, name)?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 301,
            '電源開発 奈半利川ダム情報公開サイト — 魚梁瀬/久木/平鍋ダム (UTF-8 HTML, 30分値)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(log: (s: string) => void): Promise<Map<string, bigint>> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  const universe: UniverseRow[] = [];
  for (const { name } of STATIONS) {
    const damId = chooseMaster(name, masters);
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${name}"`);
      continue;
    }
    damByName.set(name, damId);
    await bindExternalId(damId, SOURCE_ID, name);
  }
  await recordUniverse(SOURCE_ID, universe);
  return damByName;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const damByName = await matchMaster(log);

  const value = graphValue(new Date());
  const userAgent =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let parsed = 0;
  // Stations whose page yielded readings this run; the rest stay unknown
  // (an HTTP error or a blank page may be ours, not the operator's).
  const withData = new Set<string>();
  for (const { no, name } of STATIONS) {
    const url = `${BASE_URL}?value=${encodeURIComponent(value)}&no=${no}`;
    const r = await fetch(url, {
      headers: { 'user-agent': userAgent },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) {
      log(`${SOURCE_ID}: ${name} HTTP ${r.status}; skipped`);
      continue;
    }
    const graph = parseNaharigawaGraph(await r.text());
    // The page names its dam; a mismatch means `no` now points elsewhere.
    if (graph.name !== name) {
      log(`${SOURCE_ID}: no=${no} shows "${graph.name}", expected "${name}"; skipped`);
      continue;
    }
    parsed += graph.readings.length;
    if (graph.readings.length > 0) withData.add(name);
    const damId = damByName.get(name);
    if (!damId) continue;
    for (const p of graph.readings) {
      inputs.push({
        observedAt: p.observedAt,
        damId,
        sourceId: SOURCE_ID,
        storageVolumeM3: null,
        storageRate: null,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
        waterLevelM: p.waterLevelM,
        rainfallMm: null,
        rawSnapshotId: null,
        qualityFlag: 0,
      });
    }
  }

  await recordUniverseHasData(
    SOURCE_ID,
    STATIONS.map(({ name }) => ({ externalId: name, hasData: withData.has(name) ? true : null })),
  );
  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: value=${value} parsed=${parsed} matched=${damByName.size} written=${written}`,
  );
};

export default task;
