// apps/worker/src/tasks/ingest_mie_kigyo.ts
//
// 三重県企業庁「県営水道用水供給事業及び工業用水道事業の水源状況」 — the 7
// reservoirs behind the 企業庁's water-supply and industrial-water systems,
// weekly.
//
// Source: https://www.pref.mie.lg.jp/D1KIGYO/12674013222.htm
// Static UTF-8 HTML. A 「令和8年9月24日（木）現在」 line above one table:
//   <th>ダム名</th> | 有効貯水量（千ｍ３） | 現在貯水量（千ｍ３） | 貯水率（％） | 対象事業
// The page publishes no time of day, so the table is stamped 00:00 JST of the
// 現在 date. It says it is updated every Monday (Tuesday after a holiday);
// the 9/24 table went up on a Thursday, so it is polled daily.
//
// Rate: each row prints its own 有効貯水量 denominator, so the rate is kept
// only where that is the master's active capacity (observationValues). On
// the 2026-09-24 table 伊坂 3,254 / 87.5 % = 3,719 千m³ against a printed
// 3,716 and a master 3,715; 菰野調整池 1,326 / 82.8 % = 1,601 against 1,600
// and 1,600. 山村 prints 1,964 against a master 2,183 (工業用水 only, no flood
// pool to explain the gap), so its 89.4 % is on a different basis: the volume
// is stored and the rate left to the trigger's volume / active capacity.
// Where the rate is kept it is the site's own static denominator, so the
// source is not marked trusted (0048's okinawa-eb reasoning).
//
// 岩屋 (岐阜, jwa-kiso-rt / kasenbosai / gifu-kasen), 中里 (jwa-kiso-rt),
// 君ヶ野 and 蓮 (kasenbosai) are published here too but only recorded in the
// universe: they have 10-minute feeds, and at priority 291 this weekly table
// would outrank several of them. 岩屋's printed 有効 is also a seasonal
// interpolation (footnote), not a capacity. 伊坂 / 山村 / 菰野調整池 have no
// other source.
//
// Cron daily 07:17 UTC (16:17 JST), after a weekday-daytime update.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.MIE_KIGYO_URL ?? 'https://www.pref.mie.lg.jp/D1KIGYO/12674013222.htm';

const SOURCE_ID = 'mie-kigyo';
const PREF_CODE = '24';
/** 岩屋ダム is on the 飛騨川 in 岐阜; every other dam is in 三重. */
const PREF_BY_NAME: Readonly<Record<string, string>> = { 岩屋ダム: '21' };
/** Covered by 10-minute feeds; see the header. */
const UNIVERSE_ONLY: Readonly<Record<string, true>> = {
  岩屋ダム: true,
  中里ダム: true,
  君ヶ野ダム: true,
  蓮ダム: true,
};
/** Printed 有効 vs master active capacity: 伊坂 is off by 0.03 %, 山村 by 10 %. */
const CAPACITY_TOLERANCE = 0.01;

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名 as published ("伊坂ダム"); also the stamp and universe key. */
  name: string;
  /** The row's printed 有効貯水量, the denominator of its 貯水率. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

/** Tag-free, NFKC-folded (full-width digits → ASCII), whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

function num(cell: string | undefined): number | null {
  const t = flat(cell ?? '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** 「令和8年9月24日（木）現在」 → 00:00 JST of that day, in UTC. */
function parseAsOf(html: string): Date | null {
  const m = flat(html).match(/令和(元|\d{1,2})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?現在/);
  if (!m) return null;
  const year = 2018 + (m[1] === '元' ? 1 : Number(m[1]));
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), -9));
}

export function parseMieKigyoSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const name = flat(body.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '');
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (!name || cells.length !== 4) continue;
    const capacity = num(cells[0]);
    const volume = num(cells[1]);
    const rate = num(cells[2]);
    rows.push({
      name,
      capacityM3: capacity === null ? null : capacity * 1000,
      storageVolumeM3: volume === null ? null : volume * 1000,
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseAsOf(html), rows };
}

/**
 * What to store for a row: the volume always, the rate only when the row's
 * printed 有効貯水量 is the master's active capacity (else it is a percentage
 * of something the site cannot show next to it). Null when nothing is left.
 */
export function observationValues(
  row: ParsedRow,
  activeCapacityM3: number | null,
): { storageVolumeM3: number | null; storageRate: number | null } | null {
  const sameBasis =
    row.capacityM3 !== null &&
    activeCapacityM3 !== null &&
    activeCapacityM3 > 0 &&
    Math.abs(row.capacityM3 - activeCapacityM3) / activeCapacityM3 <= CAPACITY_TOLERANCE;
  const storageRate = sameBasis ? row.storageRate : null;
  if (row.storageVolumeM3 === null && storageRate === null) return null;
  return { storageVolumeM3: row.storageVolumeM3, storageRate };
}

// --- matching ---------------------------------------------------------------

export interface MieMaster extends BindableMaster {
  prefCode: string;
  activeCapacityM3?: number | null;
}

function stemOf(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** The stamped row, else the same-stem dam in the name's prefecture. */
export function chooseMaster(name: string, masters: MieMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const prefCode = PREF_BY_NAME[name] ?? PREF_CODE;
  const stem = stemOf(name);
  let best: MieMaster | null = null;
  for (const m of masters) {
    if (m.prefCode !== prefCode || stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 291,
            '三重県企業庁 県営水道用水供給事業及び工業用水道事業の水源状況 — 7 ダム (週次 HTML)',
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

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${r.status}; aborting`);
    return;
  }

  const { observedAt, rows } = parseMieKigyoSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「令和…現在」 line on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} dams as of ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: date found but no dam rows — layout change?`);
  }

  const masters = await sql<MieMaster[]>`
    SELECT id, name, pref_code AS "prefCode", completed_year AS "completedYear",
           active_capacity_m3::float8 AS "activeCapacityM3",
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code IN ${sql([PREF_CODE, ...Object.values(PREF_BY_NAME)])}
    ORDER BY id
  `;

  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = chooseMaster(p.name, masters);
    const master = masters.find((m) => m.id === damId);
    universe.push({
      externalId: p.name,
      name: p.name,
      prefCode: master?.prefCode ?? PREF_BY_NAME[p.name] ?? PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${p.name}"`);
      continue;
    }
    await bindExternalId(damId, SOURCE_ID, p.name);
    if (UNIVERSE_ONLY[p.name]) continue;
    const values = observationValues(p, master?.activeCapacityM3 ?? null);
    if (!values) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      ...values,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  await recordUniverse(SOURCE_ID, universe);

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${universe.filter((u) => u.resolvedDamId).length} written=${written}`,
  );
};

export default task;
