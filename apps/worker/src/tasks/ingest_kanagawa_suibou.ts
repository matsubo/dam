// apps/worker/src/tasks/ingest_kanagawa_suibou.ts
//
// 神奈川県雨量水位情報 — 飯泉取水堰 (酒匂川, 神奈川県内広域水道企業団, NDI 727)
// pool level, 15-minute values.
//
// The weir is a master dam row (可動堰, no capacity) that no other source
// carries: kanagawa-dam.jp lists only 相模/城山/三保/宮ヶ瀬/道志, and the 企業団
// links to that site for 水源情報. 神奈川県's river-level system has a
// 「15分間隔の観測局」 at the weir:
//
//   https://www.pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/stage/15/p10202_18_3585_4_1601.html
//
// UTF-8 水位グラフ(15分) page: header 「観測時刻 YYYY/MM/DD HH:MM」, 観測所名
// 「飯泉取水堰 [Iizumi Intake Weir]」, then a 水位表 of the last 6 h — 24 rows of
// 「HH:MM | level」, the first row and any row that starts a date printed
// 「MM/DD HH:MM」. ** marks 欠測 and -- 未収集.
//
// The level is stored as published. The page prints no datum and no flood
// thresholds (all --); 8.35–8.44 m on 2026-09-28 against a 5.4 m weir 2.3 km
// from the mouth reads as T.P., not a gauge height (the system's river gauges
// read 0.0–0.5 m that day), but nothing on the page says so.
//
// Universe: the system's ~167 stations are river gauges apart from two
// 取水堰 pools, 飯泉取水堰 and 串川取水堰 (串川, 相模原市緑区根小屋). 串川取水堰 is not
// in the NDI master; migration 0209 records why it is not a dam.
//
// Priority 308 (prefectural 防災 tier); nothing else covers 飯泉取水堰. Cron
// hourly at :43; the 24 rows re-upserted each run cover 5 missed hours.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL =
  process.env.KANAGAWA_SUIBOU_BASE_URL ??
  'https://www.pref.kanagawa.jp/sys/suibou/web_general/suibou_joho/html/stage/15';

const SOURCE_ID = 'kanagawa-suibou';
const PREF_CODE = '14';

/** The one 取水堰 station that is a master dam; key = the system's station code. */
const IIZUMI = { key: '3585_4_1601', name: '飯泉取水堰', page: 'p10202_18_3585_4_1601.html' };
/** Every 取水堰 station the system publishes. */
const WEIRS = [IIZUMI, { key: '3585_4_1507', name: '串川取水堰' }];

export interface SuibouStage {
  station: string;
  /** Oldest first. */
  readings: { observedAt: Date; waterLevelM: number }[];
}

/** Parse a 水位グラフ page; null when it carries no 観測時刻. */
export function parseSuibouStage(html: string): SuibouStage | null {
  const head = html.match(/観測時刻[\s\S]{0,80}?(\d{4})\/(\d{2})\/\d{2} \d{2}:\d{2}/);
  const station = html.match(/<th>観測所名<\/th>\s*<td[^>]*>\s*<span>([^<[]+?)\s*[[<]/);
  if (!head) return null;
  const headYear = Number(head[1]);
  const headMonth = Number(head[2]);

  const readings: SuibouStage['readings'] = [];
  let month = 0;
  let day = 0;
  for (const m of html.matchAll(
    /<td class="notranslate">(?:(\d{2})\/(\d{2}) )?(\d{2}):(\d{2})<\/td>\s*<td><span class="notranslate" data-graph-dtkey="stage_item_data_\d+">([^<]*)<\/span>/g,
  )) {
    if (m[1] && m[2]) {
      month = Number(m[1]);
      day = Number(m[2]);
    }
    if (month === 0) continue;
    const level = (m[5] ?? '').trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(level)) continue;
    // A December row on a January page is last year's.
    const year = month > headMonth ? headYear - 1 : headYear;
    readings.push({
      observedAt: new Date(Date.UTC(year, month - 1, day, Number(m[3]) - 9, Number(m[4]))),
      waterLevelM: Number(level),
    });
  }
  return { station: station?.[1] ?? '', readings };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '神奈川県雨量水位情報 — 飯泉取水堰 堰上水位 (15分値, 直近 6 時間を毎時取得)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function findDamId(log: (s: string) => void): Promise<bigint | null> {
  const rows = await sql<(BindableMaster & { rank: number })[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp, 0 AS rank
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND name = ${IIZUMI.name}
    ORDER BY id
  `;
  const dam = chooseRanked(rows, IIZUMI.key);
  const universe: UniverseRow[] = WEIRS.map((w) => ({
    externalId: w.key,
    name: w.name,
    prefCode: PREF_CODE,
    resolvedDamId: w === IIZUMI ? (dam?.id ?? null) : null,
  }));
  await recordUniverse(SOURCE_ID, universe);
  if (!dam) {
    log(`${SOURCE_ID}: no master match for ${IIZUMI.name} (pref ${PREF_CODE})`);
    return null;
  }
  await bindExternalId(dam.id, SOURCE_ID, IIZUMI.key);
  return dam.id;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  const damId = await findDamId(log);

  const res = await fetch(`${BASE_URL}/${IIZUMI.page}`, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const stage = parseSuibouStage(await res.text());
  if (!stage || stage.station !== IIZUMI.name) {
    throw new Error(
      `${SOURCE_ID}: ${IIZUMI.page} is not the ${IIZUMI.name} graph (station "${stage?.station ?? ''}")`,
    );
  }
  if (!damId) return;

  const written = await upsertObservations(
    stage.readings.map((r) => ({
      observedAt: r.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: r.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    })),
  );
  log(`${SOURCE_ID} done: parsed=${stage.readings.length} matched=1 written=${written}`);
};

export default task;
