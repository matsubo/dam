// apps/worker/src/tasks/ingest_mc_tottori_hydro.ts
//
// M&C鳥取水力発電 発電所・ダム運転情報 — the 4 dams on 鳥取県's hydro scheme.
//
//   茗荷谷ダム / 三朝調整池 / 中津ダム (県営発電専用; no other live source) and
//   菅沢ダム (国交省管理の多目的ダム; grouped on the page with 日野川第一発電所)
//
// M&C鳥取水力発電 holds the 運営権 (concession) for 鳥取県's hydro plants, so
// this page is the operator's own live feed.
//
// Source:
//   https://mchp-k.co.jp/business/list.php (UTF-8 HTML, no session; robots.txt
//   disallows only two archived 2023 pages)
//
// Each station is a `<div id="myModal…" class="reveal-modal">` whose <h1> is
// the name and whose table is label/value rows: 年月日 "YYYY/MM/DD", 時刻
// "HH:MM" (JST; one current value, refreshed every minute). Dam blocks carry
// ダム水位 or 調整池水位; 発電所 blocks (出力 / 使用水量) are skipped.
//
// Stored per dam:
//   inflow  ← 10分間流入量 (m³/s)
//   outflow ← ゲート放流量 (m³/s) — the release to the river below the dam.
//             Water taken into the headrace appears only as the downstream
//             plant's 使用水量 and is not added in. 三朝調整池 publishes no
//             release (制水門流入量 is an intake) → NULL.
// Not stored: ダム水位 / 調整池水位 are gauge heights, not EL — 菅沢 read
// 3.28 m at 21:39 JST 2026-09-27 while tottori-bousai / cgr-mlit-dam had it at
// EL 356.37 m — so they would sit on a different datum from every other
// source's water_level_m. The same page's 菅沢 ゲート放流量 (0.12) matched both
// sources' 全放流量 (0.12), which is what makes it the stored outflow. No
// volume or rate is published.
//
// Priority 301 — the lowest real-time tier. 菅沢 is also covered by
// tottori-bousai (312), kasenbosai (310), tottori-dam (307) and cgr-mlit-dam
// (304), all of which publish EL level and volume; this source must never
// outrank them there. The other three dams have no other live source.
// Cron hourly at :32.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.MC_TOTTORI_HYDRO_URL ?? 'https://mchp-k.co.jp/business/list.php';

const PREF_CODE = '31';
const SOURCE_ID = 'mc-tottori-hydro';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** <h1> name as published ("中津ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
}

/**
 * Every dam block on the page, whatever it currently reports: a station with
 * no parsable time still belongs to the published universe.
 */
export function parseMcTottoriHydro(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const blocks = html.split(/<div id="myModal[^"]*" class="reveal-modal">/).slice(1);
  for (const block of blocks) {
    const name = cellText(block.match(/<h1>([\s\S]*?)<\/h1>/)?.[1] ?? '');
    const values = new Map<string, string>();
    for (const tr of block.matchAll(
      /<td class="th">([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g,
    )) {
      values.set(cellText(tr[1] ?? ''), cellText(tr[2] ?? ''));
    }
    if (!name || !(values.has('ダム水位(m)') || values.has('調整池水位(m)'))) continue;

    const num = (label: string): number | null => {
      const text = values.get(label) ?? '';
      const n = Number(text);
      return text !== '' && Number.isFinite(n) ? n : null;
    };
    const d = (values.get('年月日') ?? '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    const t = (values.get('時刻') ?? '').match(/^(\d{1,2}):(\d{2})$/);
    rows.push({
      name,
      observedAt:
        d && t
          ? new Date(
              Date.UTC(
                Number(d[1]),
                Number(d[2]) - 1,
                Number(d[3]),
                Number(t[1]) - 9,
                Number(t[2]),
              ),
            )
          : null,
      inflowM3s: num('10分間流入量(m3/s)'),
      outflowM3s: num('ゲート放流量(m3/s)'),
    });
  }
  return rows;
}

// --- matching ---------------------------------------------------------------

/**
 * Best master dam for a published name: the row already stamped with it keeps
 * it; otherwise the exact stem ("中津ダム" / "三朝調整池" → 中津 / 三朝), the
 * live （元）/（再） twin before the lower id. Only exact stems bind — the
 * names are short enough that a prefix or substring hit (中津 → 中津川) would
 * be a different dam.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stemOf = (s: string): string =>
    s
      .normalize('NFKC')
      .replace(/\([^)]*\)/g, '')
      .replace(/(ダム|調整池)$/, '')
      .trim();
  const stem = stemOf(name);
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 301,
            'M&C鳥取水力発電 発電所・ダム運転情報 — 鳥取県営発電 4 ダム (流入量・ゲート放流量, 毎分更新の現在値)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(
  rows: ParsedRow[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const damId = chooseMaster(r.name, masters);
    universe.push({ externalId: r.name, name: r.name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.name}"`);
      continue;
    }
    damByName.set(r.name, damId);
    await bindExternalId(damId, SOURCE_ID, r.name);
  }

  await recordUniverse(SOURCE_ID, universe);
  return damByName;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(DATA_URL, {
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

  const rows = parseMcTottoriHydro(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);
  if (rows.length === 0) {
    log(`${SOURCE_ID}: no dam blocks on the page; not recording an empty universe`);
    return;
  }

  const damByName = await matchMaster(rows, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.name);
    if (!damId) continue;
    if (!p.observedAt) {
      log(`${SOURCE_ID}: no observation time for "${p.name}"; skipping`);
      continue;
    }
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);
};

export default task;
