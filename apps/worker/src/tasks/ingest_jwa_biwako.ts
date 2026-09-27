// apps/worker/src/tasks/ingest_jwa_biwako.ts
//
// 水資源機構 琵琶湖総合管理所 堰諸量 — 琵琶湖 (master 琵琶湖開発), hourly.
//
// Source:
//   http://www.biwako-mizukanri.jp/daminfo1_h.json
//   (the data behind daminfo1_h.html, 堰諸量 1時間表示; linked from 水資源機構
//   リアルタイム水源情報. The host serves plain HTTP only; no robots.txt.)
//
// Payload: {"measure_date": "...", "data": [25 rows, oldest first]}, each row
// {"datestr": "YYYY-MM-DD HH:MM" (JST), "ana0" … "ana8": decimal strings}.
// Columns per daminfo1_h.html:
//   ana0 琵琶湖 河川水位 [m, B.S.L.]   ana1 総流入量 [m³/s]   ana2 総流出量 [m³/s]
//   ana3 洗堰全放流量   ana4 バイパス   ana5 バルブ   ana6 本堰   [m³/s]
//   ana7 / ana8 琵琶湖疏水１ / ２ 河川流量 [m³/s]
// The lake is the reservoir, so inflow/outflow are its 総流入量 / 総流出量
// (総流出量 = 洗堰 + 疏水 + 宇治発電 withdrawals), not the 洗堰 release alone.
//
// Level: the page prints B.S.L. (琵琶湖基準水位). B.S.L. ±0 = T.P. +84.371 m
// (国土交通省 琵琶湖河川事務所 FAQ, kkr.mlit.go.jp/biwako/info/faq/qlist/qlista/a32.html),
// so the stored level is T.P. elevation like every other dam's EL.m.
//
// No 貯水量 / 貯水率 is published; volume and rate stay NULL (not
// trusted_rate_basis). Missing values: any blank / non-numeric cell → null.
//
// Priority 297 (JWA realtime siblings: jwa-yoshino / jwa-chikugo). The only
// other source on this dam is mudam (280). Cron hourly at :54; each run
// re-upserts the 24-hour window so an outage self-heals.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.JWA_BIWAKO_URL ?? 'http://www.biwako-mizukanri.jp/daminfo1_h.json';

const SOURCE_ID = 'jwa-biwako';
const PREF_CODE = '25';
/** The page's 局名 for the lake — the universe key and the stamp. */
const STATION = '琵琶湖';
const MASTER_NAME = '琵琶湖開発';
/** T.P. elevation of B.S.L. ±0 m. */
const BSL_DATUM_TP_M = 84.371;

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

function cellValue(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Every row with a parsable "YYYY-MM-DD HH:MM" JST time, oldest first. */
export function parseBiwakoDamInfo(text: string): ParsedRow[] {
  const body = JSON.parse(text.replace(/^\uFEFF/, '')) as { data?: Record<string, unknown>[] };
  const out: ParsedRow[] = [];
  for (const r of body.data ?? []) {
    const m = String(r.datestr ?? '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!m) continue;
    const observedAt = new Date(
      Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
    );
    const bsl = cellValue(r.ana0);
    out.push({
      observedAt,
      // Rounded to the mm: the B.S.L. reading has cm resolution, and the float
      // sum would otherwise store 84.04100000000001.
      waterLevelM: bsl === null ? null : Math.round((BSL_DATUM_TP_M + bsl) * 1000) / 1000,
      inflowM3s: cellValue(r.ana1),
      outflowM3s: cellValue(r.ana2),
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 297,
            '水資源機構 琵琶湖総合管理所 堰諸量 — 琵琶湖 水位 (B.S.L.→T.P.)・総流入量・総流出量, hourly',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(log: (s: string) => void): Promise<bigint | null> {
  const rows = await sql<(BindableMaster & { rank: number })[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp,
           CASE WHEN name = ${MASTER_NAME} THEN 0 ELSE 5 END AS rank
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND name LIKE ${`%${STATION}%`}
    ORDER BY rank, id
  `;
  const r = chooseRanked(rows, STATION);
  // The provider publishes exactly this one station; recorded whether or not
  // it binds so /coverage can tell a failed link from absence.
  await recordUniverse(SOURCE_ID, [
    { externalId: STATION, name: STATION, prefCode: PREF_CODE, resolvedDamId: r?.id ?? null },
  ]);
  if (!r) {
    log(`${SOURCE_ID}: no master match for ${STATION} (${MASTER_NAME})`);
    return null;
  }
  await bindExternalId(r.id, SOURCE_ID, STATION);
  return r.id;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const damId = await matchMaster(log);

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
  const rows = parseBiwakoDamInfo(await r.text());
  log(`${SOURCE_ID}: parsed ${rows.length} hourly rows`);
  if (!damId) return;

  const written = await upsertObservations(
    rows.map((p) => ({
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
    })),
  );
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=1 written=${written}`);
};

export default task;
