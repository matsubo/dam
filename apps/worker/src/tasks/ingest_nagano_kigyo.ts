// apps/worker/src/tasks/ingest_nagano_kigyo.ts
//
// 長野県企業局 ダム情報 — the 企業局's own 10分諸量 for its generating dams.
//
//   高遠ダム (天竜川水系三峰川; 発電・かんがい) — kasenbosai rows are all NULL
//   菅平ダム (信濃川水系神川; かんがい・発電・上水道) — no other live source
//
// Source: https://naganoken-kigyokyoku.jp/dam/ loads, per dam,
//   https://naganoken-kigyokyoku.jp/json/{takato,sugadaira}_new.json
// ({"table":[…]}, the four newest 10-minute rows, newest first). robots.txt
// disallows only /wp/wp-admin/. The page's third dam, 湯の瀬, has a camera
// image and no figures, so it is not part of the published universe.
//
// Keys differ per dam (the page's own dam_data_new.js maps them):
//   高遠   v_reservoirlevel10 (EL.m) · v_totalinflow1 (old name v_totalinflow11)
//          · v_totaldischarge11
//   菅平   v_reservoirlevel13 (EL.m) · v_totalinflow11 · v_totaldischarge11
//          · v_chor 貯水率 (%)
// v_reservoirlevel1 / v_reservoirlevel7 are gauge heights (9.26 / 15.31 m)
// and are not read. Cells are strings; "欠測" / "未実装" → null.
//
// Rows carry "HH:MM" only. The date comes from the file's Last-Modified
// header, which the server sets when it rewrites the file (12:40:33 GMT for
// a newest row of 21:40 JST in the fixture): the newest row is the latest
// HH:MM at or before that instant, and each older row steps back across
// midnight when its clock time is not earlier than the row before it. A file
// that stops being rewritten keeps its old Last-Modified, so a stale feed
// re-upserts the same old rows instead of stamping them with today's date.
// No Last-Modified → the dam is skipped.
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
// hyogo-bodik, which never cover 長野. Alone on 菅平. Cron hourly at :50.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.NAGANO_KIGYO_JSON_BASE ?? 'https://naganoken-kigyokyoku.jp/json';

const PREF_CODE = '20';
const SOURCE_ID = 'nagano-kigyo';

export interface DamCfg {
  /** JSON file stem; also the stamp and universe key. */
  key: string;
  /** Name as the 企業局 page prints it. */
  name: string;
  masterName: string;
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
    masterName: '高遠',
    level: 'v_reservoirlevel10',
    inflow: ['v_totalinflow1', 'v_totalinflow11'],
    outflow: 'v_totaldischarge11',
    rate: null,
  },
  {
    key: 'sugadaira',
    name: '菅平ダム',
    masterName: '菅平',
    level: 'v_reservoirlevel13',
    inflow: ['v_totalinflow11'],
    outflow: 'v_totaldischarge11',
    rate: 'v_chor',
  },
];

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

const JST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The table's rows with dates reconstructed from `lastModified` (see header).
 * Rows without a parsable "HH:MM" are dropped.
 */
export function parseNaganoKigyoTable(json: string, cfg: DamCfg, lastModified: Date): ParsedRow[] {
  const table = (JSON.parse(json) as { table?: Record<string, string | null>[] }).table ?? [];
  const num = (v: string | null | undefined): number | null => {
    if (v == null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

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
    const rate = cfg.rate === null ? null : num(r[cfg.rate]);
    rows.push({
      observedAt: new Date(at),
      waterLevelM: num(r[cfg.level]),
      inflowM3s: inflowKey === undefined ? null : num(r[inflowKey]),
      outflowM3s: num(r[cfg.outflow]),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 311,
            '長野県企業局 ダム情報 10分諸量 — 高遠・菅平 (貯水位・全流入量・全放流量, 菅平は貯水率)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  cfg: DamCfg;
  damId: bigint;
}

async function matchMaster(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  const universe: UniverseRow[] = [];
  for (const c of DAMS) {
    const candidates = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>${SOURCE_ID} AS stamp,
             CASE
               WHEN name = ${c.masterName} THEN 0
               WHEN name LIKE ${`${c.masterName}（再）%`}
                 OR name LIKE ${`${c.masterName}（元）%`} THEN 0
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND (name = ${c.masterName} OR name LIKE ${`${c.masterName}（%`}
             OR external_ids->>${SOURCE_ID} = ${c.key})
    `;
    const m = chooseRanked(candidates, c.key);
    universe.push({
      externalId: c.key,
      name: c.name,
      prefCode: PREF_CODE,
      resolvedDamId: m?.id ?? null,
    });
    if (!m) {
      log(`${SOURCE_ID}: no master match for ${c.name}`);
      continue;
    }
    matches.push({ cfg: c, damId: m.id });
    await bindExternalId(m.id, SOURCE_ID, c.key);
  }
  await recordUniverse(SOURCE_ID, universe);
  return matches;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await matchMaster(log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let parsed = 0;
  for (const { cfg, damId } of matches) {
    const r = await fetch(`${BASE_URL}/${cfg.key}_new.json`, {
      headers: {
        'user-agent':
          process.env.HTTP_USER_AGENT ??
          'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) {
      log(`${SOURCE_ID}: ${cfg.name} HTTP ${r.status}; skipping`);
      continue;
    }
    const lastModified = new Date(r.headers.get('last-modified') ?? '');
    if (Number.isNaN(lastModified.getTime())) {
      log(`${SOURCE_ID}: ${cfg.name} has no Last-Modified; cannot date its rows, skipping`);
      continue;
    }
    let rows: ParsedRow[];
    try {
      rows = parseNaganoKigyoTable(await r.text(), cfg, lastModified);
    } catch (e) {
      log(`${SOURCE_ID}: ${cfg.name} JSON parse failed: ${String(e)}`);
      continue;
    }
    parsed += rows.length;
    for (const p of rows) {
      inputs.push({
        observedAt: p.observedAt,
        damId,
        sourceId: SOURCE_ID,
        storageVolumeM3: null,
        storageRate: p.storageRate,
        inflowM3s: p.inflowM3s,
        outflowM3s: p.outflowM3s,
        waterLevelM: p.waterLevelM,
        rainfallMm: null,
        rawSnapshotId: null,
        qualityFlag: 0,
      });
    }
  }

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: dams=${DAMS.length} matched=${matches.length} rows=${parsed} written=${written}`,
  );
};

export default task;
