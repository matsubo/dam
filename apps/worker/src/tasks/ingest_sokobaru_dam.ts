// apps/worker/src/tasks/ingest_sokobaru_dam.ts
//
// 底原ダム管理システム — the 底原ダム management system's own public pages for
// the 石垣島 irrigation dams: 底原 (NDI 2752), 真栄里 (NDI 2753), 石垣
// (NDI 2751), plus two intake weirs (二又堰 / 平喜名堰). No other source we
// ingest lists any of the three (prod source_universe, 2026-09-28). 沖縄県ダム
// 情報 (bousai-kasen.pref.okinawa.jp/river/dam/) shows 真栄里 too, but with
// ---- in every row of its 5-minute (2 h) and hourly (24 h) tables on 2026-09-28.
//
// Source: http://www.cosmos.ne.jp/~sokobaru/index.html (MainMenu). Static
// Shift_JIS i-mode style pages the dam office's system re-uploads every few
// minutes (Last-Modified tracks the clock). Per dam, a 水文量 page
// (00001001 底原 / 00004001 真栄里 / 00005001 石垣) shows the latest values
// and links each reading to an hourly page:
//   <DIV ALIGN="center">2026/09/28 15:00</DIV>   newest row, JST
//   <DIV ALIGN="center">[EL.m]</DIV>             unit
//   <DIV ALIGN="left">15:00　　35.65</DIV>        13 rows, newest first; ** = 欠測
// Read: 貯水位 (EL.m), 総貯水量 / 貯水量 (千m3 → m³), 貯水率 (%, 底原 only),
// 全流入量 (底原), 全放流量 (底原) / 放流量 (真栄里, 石垣). 底原's 放流管 /
// 洪水吐 / 注水維持 / 底原幹線 are outlets of the 全放流量, and 於茂登導水量 is a
// transfer in; none is stored. Every run re-reads all 13 hours, so a missed
// run or a late correction is picked up.
//
// Volume: 総貯水量 is gross, counted from the bed, while the observation
// trigger and the site divide by 有効貯水容量. 底原's printed 貯水率 is
// (総貯水量 − 150) / 12,850 千m³ on every fixture row (8,091 → 61.8 %,
// 11,279 → 86.6 %, 11,292 → 86.7 %), and 150 千m³ is exactly the master's
// 総 − 有効 (13,000 − 12,850), i.e. its 堆砂容量. So, as in ingest_jwa_fukudou
// and ingest_nara_kasen, the stored volume is 総貯水量 − (総 − 有効), and only
// in an hour whose printed rate ties to that figure over the master's 有効.
// The rate is stored as printed: its denominator is the master's own 有効,
// a static one, so it is not trusted (0048's okinawa-eb reasoning).
//
// 真栄里 and 石垣 print no 貯水率, so nothing ties their gross figure to the
// master's capacities, and they store level and outflow only. For 真栄里 the
// subtraction would not even be safe to infer: its 総貯水量 reads 1,500 千m³
// at 38.00 EL.m, the 常時満水位 on 沖縄県ダム情報, while the master's 総
// 2,300 千m³ (FNA) runs up to the サーチャージ水位 41.50 and includes the flood
// pool, so 総 − 有効 = 200 千m³ is not shown to be the page's dead storage.
//
// Binding: NDI pins, from the master's ダム便覧 cross-ids: 底原 NDI 2752
// (ダム便覧 2903, 宮良川水系底原川), 真栄里 NDI 2753 (2897, 宮良川), 石垣
// NDI 2751 (2937, 宮良川水系磯辺川) — "石垣" alone also names the island and
// the city, so the name is only a fallback. The weirs have no master row;
// 0220 records why they stay unresolved.
//
// Licence: the pages state no terms of use and no operator; there is no
// robots.txt (404, checked 2026-09-28).
//
// Priority 291: no other source carries these dams except mudam (280), which
// holds 真栄里's 1-2 year old daily figures; 291 is unused. Cron hourly at :05.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.SOKOBARU_DAM_URL ?? 'http://www.cosmos.ne.jp/~sokobaru/';

const SOURCE_ID = 'sokobaru-dam';
const PREF_CODE = '47';

/** The MainMenu's facilities. `page` is null for the weirs, which are not dams. */
export const STATIONS: { key: string; page: string | null; ndi: string | null }[] = [
  { key: '底原ダム', page: '00001001.html', ndi: '2752' },
  { key: '真栄里ダム', page: '00004001.html', ndi: '2753' },
  { key: '石垣ダム', page: '00005001.html', ndi: '2751' },
  { key: '二又堰', page: null, ndi: null },
  { key: '平喜名堰', page: null, ndi: null },
];

// --- parsing ----------------------------------------------------------------

export interface HourlySeries {
  label: string;
  unit: string;
  points: { observedAt: Date; value: number | null }[];
}

/** One hourly page; null when it lacks the dated header (a 水文量 or menu page). */
export function parseHourlyPage(html: string): HourlySeries | null {
  const head = html.match(/<DIV ALIGN="center">(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):00<\/DIV>/);
  const label = html.match(/<HR>\s*<DIV ALIGN="center">([^<]+)<\/DIV>/)?.[1]?.trim();
  const unit = html.match(/<DIV ALIGN="center">\[([^\]]+)\]<\/DIV>/)?.[1];
  if (!head || !label || !unit) return null;

  // Walk back from the header's day; a row later in the day than the one
  // above it belongs to the day before.
  const day = new Date(Date.UTC(Number(head[1]), Number(head[2]) - 1, Number(head[3])));
  let prevHour = Number(head[4]);
  const points: HourlySeries['points'] = [];
  for (const m of html.matchAll(/<DIV ALIGN="left">(\d{2}):00[\s\u3000]+([^<]*)<\/DIV>/g)) {
    const hour = Number(m[1]);
    if (hour > prevHour) day.setUTCDate(day.getUTCDate() - 1);
    prevHour = hour;
    const text = (m[2] ?? '').trim();
    points.push({
      observedAt: new Date(day.getTime() + (hour - 9) * 3_600_000),
      value: /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : null,
    });
  }
  return { label, unit, points };
}

/** A 水文量 page's readings and the hourly page each links to. */
export function parseFieldLinks(html: string): { href: string; label: string }[] {
  return [
    ...html.matchAll(
      /<A href="\.\/(\d{8}\.html)"><FONT color="#0000FF">([^<]+)<\/FONT><\/A>[\s\u3000]/g,
    ),
  ].map((m) => ({ href: m[1] as string, label: m[2] as string }));
}

export interface Reading {
  observedAt: Date;
  waterLevelM: number | null;
  /** 総貯水量 / 貯水量 as published: gross, from the bed. See usableVolumeM3. */
  grossVolumeM3: number | null;
  /** 0..1 fraction. */
  storageRate: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

type Field = Exclude<keyof Reading, 'observedAt'>;

/** Hourly page label → stored field and the factor from its unit. */
const FIELDS: Record<string, { field: Field; unit: string; scale: number }> = {
  貯水位: { field: 'waterLevelM', unit: 'EL.m', scale: 1 },
  総貯水量: { field: 'grossVolumeM3', unit: '千m3', scale: 1000 },
  貯水量: { field: 'grossVolumeM3', unit: '千m3', scale: 1000 },
  貯水率: { field: 'storageRate', unit: '％', scale: 0.01 },
  全流入量: { field: 'inflowM3s', unit: 'm3/s', scale: 1 },
  全放流量: { field: 'outflowM3s', unit: 'm3/s', scale: 1 },
  放流量: { field: 'outflowM3s', unit: 'm3/s', scale: 1 },
};

/** One row per hour across a dam's pages; hours with every value missing are dropped. */
export function readingsOf(series: (HourlySeries | null)[]): Reading[] {
  const byHour = new Map<number, Reading>();
  for (const s of series) {
    const f = s ? FIELDS[s.label] : undefined;
    if (!s || !f || f.unit !== s.unit) continue;
    for (const p of s.points) {
      if (p.value === null) continue;
      const t = p.observedAt.getTime();
      const row = byHour.get(t) ?? {
        observedAt: p.observedAt,
        waterLevelM: null,
        grossVolumeM3: null,
        storageRate: null,
        inflowM3s: null,
        outflowM3s: null,
      };
      // Rounded: 0.866 must stay 0.866, not 86.6 × 0.01's float tail.
      row[f.field] = Math.round(p.value * f.scale * 1e6) / 1e6;
      byHour.set(t, row);
    }
  }
  return [...byHour.values()].sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime());
}

/**
 * ** in every hour of every page is the office's own 欠測 (false); a value in
 * any hour is data (true). Anything else — no pages, a page that failed to
 * load or parse, a label or unit we do not store — may be our own breakage,
 * so it stays unknown.
 */
export function hasDataOf(series: (HourlySeries | null)[]): boolean | null {
  if (readingsOf(series).length > 0) return true;
  if (series.length === 0) return null;
  return series.every((s) => s !== null && FIELDS[s.label]?.unit === s.unit) ? false : null;
}

export interface MasterCapacity {
  totalCapacityM3: number | null;
  activeCapacityM3: number | null;
}

/** The printed 貯水率 has one decimal of a percent. */
const RATE_ROUNDING = 0.0005;

/**
 * Water above 最低水位 (m³), comparable with 有効貯水容量: the gross volume less
 * 堆砂容量 (master 総 − 有効). Null unless the hour's printed 貯水率 is that
 * figure over the master 有効, which is what ties the gross reading to the
 * master's capacity table; a dam that prints no rate never stores a volume.
 */
export function usableVolumeM3(
  r: Pick<Reading, 'grossVolumeM3' | 'storageRate'>,
  cap: MasterCapacity,
): number | null {
  const { totalCapacityM3: total, activeCapacityM3: active } = cap;
  if (r.grossVolumeM3 === null || r.storageRate === null) return null;
  if (total === null || active === null || active <= 0 || total < active) return null;
  const usable = Math.max(0, r.grossVolumeM3 - (total - active));
  if (Math.abs(r.storageRate - usable / active) > RATE_ROUNDING + 1e-9) return null;
  return usable;
}

// --- matching ---------------------------------------------------------------

export type NdiMaster = BindableMaster & { ndi: string | null };

/** The stamped row, else the pinned NDI row, else the dam of the same name. */
export function chooseMaster(
  station: { key: string; ndi: string | null },
  masters: NdiMaster[],
): bigint | null {
  const stem = station.key.replace(/ダム$/, '');
  const ranked = masters.flatMap((m) => {
    if (m.stamp === station.key) return [{ ...m, rank: 0 }];
    if (station.ndi !== null && m.ndi === station.ndi) return [{ ...m, rank: 0 }];
    if (m.name.replace(/[（(][^）)]*[）)]/g, '') === stem) return [{ ...m, rank: 1 }];
    return [];
  });
  return chooseRanked(ranked, station.key)?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 291,
            '底原ダム管理システム — 石垣島 底原/真栄里/石垣ダム (時次 HTML, 直近 13 時間)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const get = async (path: string): Promise<string | null> => {
    const r = await fetch(new URL(path, BASE_URL), {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) {
      log(`${SOURCE_ID}: HTTP ${r.status} for ${path}`);
      return null;
    }
    return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  };

  const masters = await sql<(NdiMaster & MasterCapacity)[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>'ndi' AS ndi,
           external_ids->>${SOURCE_ID} AS stamp,
           total_capacity_m3::float8 AS "totalCapacityM3",
           active_capacity_m3::float8 AS "activeCapacityM3"
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let parsed = 0;
  let matched = 0;
  for (const station of STATIONS) {
    const damId = chooseMaster(station, masters);
    const master = masters.find((m) => m.id === damId);
    let hasData: boolean | null = null;
    if (station.page) {
      const html = await get(station.page);
      const links = html ? parseFieldLinks(html).filter((l) => l.label in FIELDS) : [];
      const series: (HourlySeries | null)[] = [];
      for (const l of links) {
        const page = await get(l.href);
        series.push(page ? parseHourlyPage(page) : null);
      }
      const readings = readingsOf(series);
      parsed += readings.length;
      hasData = hasDataOf(series);
      if (master) {
        for (const { grossVolumeM3, ...r } of readings) {
          const storageVolumeM3 = usableVolumeM3(
            { grossVolumeM3, storageRate: r.storageRate },
            master,
          );
          // An hour whose only value was an untied gross volume stores nothing.
          if (
            storageVolumeM3 === null &&
            r.waterLevelM === null &&
            r.storageRate === null &&
            r.inflowM3s === null &&
            r.outflowM3s === null
          ) {
            continue;
          }
          inputs.push({
            ...r,
            storageVolumeM3,
            damId: master.id,
            sourceId: SOURCE_ID,
            rainfallMm: null,
            rawSnapshotId: null,
            qualityFlag: 0,
          });
        }
      }
    }
    // Pushed before the unmatched skip: the list is what /coverage reads.
    universe.push({
      externalId: station.key,
      name: station.key,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      hasData,
    });
    if (!damId) {
      if (station.page) log(`${SOURCE_ID}: no master match for ${station.key}`);
      continue;
    }
    matched++;
    await bindExternalId(damId, SOURCE_ID, station.key);
  }
  await recordUniverse(SOURCE_ID, universe);

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${parsed} matched=${matched} written=${written}`);
  if (universe.every((u) => u.hasData == null)) {
    throw new Error(`${SOURCE_ID}: no dam page parsed under ${BASE_URL} — layout change?`);
  }
};

export default task;
