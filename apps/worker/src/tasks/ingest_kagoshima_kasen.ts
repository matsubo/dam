// apps/worker/src/tasks/ingest_kagoshima_kasen.ts
//
// 鹿児島県河川砂防情報システム ダム一覧表 (全県) — 3 県管理ダム, 10-minute values.
//
//   西之谷 (鹿児島市, 治水専用) / 川辺 (南九州市) / 大和 (大島郡大和村)
//
// Source:
//   https://www3.doboku-bousai.pref.kagoshima.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4
//   (the ダム → 一覧表 page of index.jsp; Shift_JIS HTML, no session needed)
//
// Unlike ingest_kagoshima_bousai (防災ポータル dam_station.json, populated only
// during flood events), this table is published continuously.
//
// Columns per dam row (10 <td>):
//   局名 | 所在地 | 最新観測時刻 "YYYY/MM/DD&nbsp;HH:MM" (JST) |
//   貯水位[EL.m] | 貯水量[10³m³] | 全流入量[m³/s] | 全放流量[m³/s] |
//   空容量[10³m³] | 貯水率（治水）[%] | 貯水率（利水）[%]
// Values carry a trend arrow entity (&rarr; &uarr; &darr;). Legend markers:
// *** 欠測, --- 無効, ### 範囲異常, blank 未入力 — all read as null.
//
// Rate: 貯水率（利水） only. Back-solved from the servlet's own history
// (tm=…, 2026-04 … 2026-09) against the master:
//   利水  川辺 587/88.9 % = 660, 650/98.5 % = 660 千m³ (annual 有効 2,460)
//         大和 172/84.2 % = 204, 199/97.7 % = 204 千m³ (annual 有効 721)
//   治水  大和 199/27.7 % = 718, 214/29.7 % = 721 千m³ = 有効貯水容量
// So 利水 divides by the 利水 pool, and 治水 by the same static 有効 figure the
// site already uses. 西之谷 publishes only 治水; it is stored with a NULL rate
// rather than mixing a second denominator into a trusted source. 利水 is
// clamped at 100.0 once the level passes 常時満水位.
//
// Priority 309 — one above kagoshima-bousai (308), which covers the same 3
// dams but only during flood events. With equal priorities
// preferredSourceForDam() (ORDER BY priority DESC LIMIT 1) has no tiebreak,
// so the chart source would flip after every flood; the continuous, trusted
// 利水 series should keep winning. Cron hourly at :52.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.KAGOSHIMA_KASEN_DAM_URL ??
  'https://www3.doboku-bousai.pref.kagoshima.jp/bousai/servlet/bousaiweb.servletBousaiTableStatus?dk=4';

const PREF_CODE = '46';
const SOURCE_ID = 'kagoshima-kasen';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 局名 as published ("川辺ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date | null;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** 貯水率（利水） as a 0..1 fraction. */
  storageRate: number | null;
}

/** Cell text → number; markers (***, ---, ###) and blanks → null. */
function cellValue(cell: string | undefined): number | null {
  const text = (cell ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** "YYYY/MM/DD&nbsp;HH:MM" JST → UTC Date */
function parseJst(cell: string | undefined): Date | null {
  const m = (cell ?? '').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:&nbsp;|\s)+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every dam row of the 一覧表, whatever it currently reports: a station with
 * no parsable time still belongs to the published universe.
 */
export function parseKagoshimaKasenTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length !== 10) continue;
    const name = cells[0]?.match(/<a[^>]*>([^<]+)<\/a>/i)?.[1]?.trim();
    if (!name) continue;
    const volume = cellValue(cells[4]);
    const rate = cellValue(cells[9]);
    rows.push({
      name,
      observedAt: parseJst(cells[2]),
      waterLevelM: cellValue(cells[3]),
      storageVolumeM3: volume === null ? null : volume * 1_000,
      inflowM3s: cellValue(cells[5]),
      outflowM3s: cellValue(cells[6]),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return rows;
}

// --- matching ---------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * Best master dam for a published 局名: the row already stamped with it keeps
 * it; otherwise an exact stem beats a prefix beats a substring, and equal
 * ranks go to the live （元）/（再） twin before the lower id.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = normalizeName(name);
  if (!stem) return null;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (mStem.startsWith(stem)) rank = 1;
    else if (mStem.includes(stem)) rank = 2;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 309,
            '鹿児島県河川砂防情報システム ダム一覧表 — 3 ダム (Shift_JIS HTML, 10分更新)',
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
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
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

  const html = new TextDecoder('shift_jis').decode(await r.arrayBuffer());
  const rows = parseKagoshimaKasenTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

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
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);
};

export default task;
