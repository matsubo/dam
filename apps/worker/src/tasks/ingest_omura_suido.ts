// apps/worker/src/tasks/ingest_omura_suido.ts
//
// 大村市上下水道局「ダム（水源）情報」 — the city's two 水道 sources, daily.
//
// Source: https://omura-waterworks.jp/water/ (a PHP page on the bureau's own
// site, in its main menu). One UTF-8 table under 「令和8年9月28日午前7時00分現在」:
//   施設名 | 利水貯水量 (m³) | 現在利水貯水量 (m³) | 利水貯水率 (%)
// with two rows, 「萱瀬ダム（大村市水道用水分）」 and 「池田貯水池」. The rate
// cell is not closed before the gauge-image cell, so the columns are read as
// the first four <td> matches of each row.
//
// Written: 池田 only. 池田貯水池 is 池田（再） (NDI 2583, 1986, 有効 209,000 m³):
// the master holds the 1952 dam and its 1986 redevelopment as a （元）/（再）
// pair 33 m apart, and the twin rule picks the completed （再）, whose capacity
// is the one the page's 200,000 fits. No other source publishes it. The 萱瀬 row is the city's
// 水道 share (1,017,000 m³) of the 長崎県 multipurpose dam that kasenbosai and
// nagasaki-kasen already carry whole, so it is recorded in the universe only,
// as nagasaki-city-suido does for its share rows.
//
// Rate: 183,274 / 91.6 % = 200,081 m³ — the printed 利水貯水量 200,000, below
// the master's 有効 209,000; trusted in 0219 so the site shows the city's rate.
// WRITE pins that 200,000: a different figure means the page changed what it
// divides by, and the run stops writing 池田 until the binding is re-checked.
//
// Priority 292: nothing else publishes 池田; 萱瀬 is never written.
// Cron daily 01:41 UTC (10:41 JST), after the 07:00 edition.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.OMURA_SUIDO_URL ?? 'https://omura-waterworks.jp/water/';

const PREF_CODE = '42';
const SOURCE_ID = 'omura-suido';

/** Rows whose readings are written, with the 利水貯水量 their binding assumes. */
const WRITE: Readonly<Record<string, { capacityM3: number }>> = {
  池田貯水池: { capacityM3: 200_000 },
};

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 施設名 as printed, tags dropped ("萱瀬ダム（大村市水道用水分）"); also the stamp and universe key. */
  name: string;
  /** 利水貯水量 (m³), the figure the rate divides by. */
  capacityM3: number | null;
  /** 現在利水貯水量 (m³). */
  storageVolumeM3: number | null;
  /** 利水貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

export interface ParsedPage {
  /** The 「…時…分現在」 line in UTC, or null if it is missing. */
  observedAt: Date | null;
  rows: ParsedRow[];
}

/** Tag-free, NFKC-folded, whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

function num(cell: string | undefined): number | null {
  const m = flat(cell ?? '')
    .replace(/,/g, '')
    .match(/^(\d+(?:\.\d+)?)%?$/);
  return m ? Number(m[1]) : null;
}

export function parseOmuraWater(html: string): ParsedPage {
  const d = flat(html).match(
    /令和(元|\d+)年(\d{1,2})月(\d{1,2})日(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?現在/,
  );
  const observedAt = d
    ? new Date(
        Date.UTC(
          2018 + (d[1] === '元' ? 1 : Number(d[1])),
          Number(d[2]) - 1,
          Number(d[3]),
          Number(d[5]) + (d[4] === '午後' && Number(d[5]) < 12 ? 12 : 0) - 9,
          Number(d[6] ?? 0),
        ),
      )
    : null;

  const rows: ParsedRow[] = [];
  const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < 4) continue;
    const name = flat(cells[0] ?? '')
      .replace(/\(/g, '（')
      .replace(/\)/g, '）');
    if (!name) continue;
    const rate = num(cells[3]);
    rows.push({
      name,
      capacityM3: num(cells[1]),
      storageVolumeM3: num(cells[2]),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt, rows };
}

// --- matching ---------------------------------------------------------------

export type OmuraMaster = BindableMaster;

/** Page name without its （…） note and ダム / 貯水池; master name without （元）/（再）, ダム. */
function stemOf(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\([^)]*\)/g, '')
    .replace(/(ダム|貯水池)$/, '')
    .trim();
}

/** The stamped row, else the dam of the same stem (（元）/（再） by the twin rule). */
export function chooseMaster(name: string, masters: OmuraMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = stemOf(name);
  let best: OmuraMaster | null = null;
  for (const m of masters) {
    if (stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

export interface OmuraPlan {
  universe: UniverseRow[];
  writes: { damId: bigint; row: ParsedRow }[];
  /** WRITE rows whose printed 利水貯水量 no longer matches the binding. */
  drift: string[];
}

/** The whole list for the universe; readings only for WRITE rows that still fit. */
export function planOmura(rows: ParsedRow[], masters: OmuraMaster[]): OmuraPlan {
  const universe: UniverseRow[] = [];
  const writes: OmuraPlan['writes'] = [];
  const drift: string[] = [];
  for (const row of rows) {
    const damId = chooseMaster(row.name, masters);
    universe.push({
      externalId: row.name,
      name: row.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      hasData: row.storageVolumeM3 !== null || row.storageRate !== null,
    });
    const want = WRITE[row.name];
    if (!want || !damId) continue;
    if (row.capacityM3 !== want.capacityM3) {
      drift.push(`${row.name} 利水貯水量 ${row.capacityM3} (binding assumes ${want.capacityM3})`);
      continue;
    }
    if (row.storageVolumeM3 === null && row.storageRate === null) continue;
    writes.push({ damId, row });
  }
  return { universe, writes, drift };
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 292,
            '大村市上下水道局 ダム（水源）情報 — 池田貯水池 (日次 07:00, 利水貯水量+利水貯水率)',
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

  const { observedAt, rows } = parseOmuraWater(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} rows, 現在 ${observedAt?.toISOString() ?? 'missing'}`);
  if (!observedAt || rows.length === 0) {
    throw new Error(
      `${SOURCE_ID}: ${rows.length} rows / date ${observedAt ? 'found' : 'missing'} on ${PAGE_URL} — layout change?`,
    );
  }

  const masters = await sql<OmuraMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const plan = planOmura(rows, masters);
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  await recordUniverse(SOURCE_ID, plan.universe);
  for (const u of plan.universe) {
    if (!u.resolvedDamId) log(`${SOURCE_ID}: no master match for "${u.name}"`);
  }
  for (const w of plan.writes) await bindExternalId(w.damId, SOURCE_ID, w.row.name);

  const written = await upsertObservations(
    plan.writes.map(({ damId, row }) => ({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    })),
  );
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${plan.universe.filter((u) => u.resolvedDamId).length} written=${written}`,
  );

  if (plan.drift.length > 0) {
    throw new Error(`${SOURCE_ID}: ${plan.drift.join('; ')} — re-check WRITE`);
  }
};

export default task;
