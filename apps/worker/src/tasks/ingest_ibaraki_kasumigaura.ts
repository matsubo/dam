// apps/worker/src/tasks/ingest_ibaraki_kasumigaura.ts
//
// 茨城県河川情報 — 霞ヶ浦 出島 水位 as the lake level of 霞ヶ浦開発 (NDI 597).
//
// 霞ヶ浦開発 is the lake itself: JWA stores 6億1,700万m³ between Y.P.±0.00 m
// and Y.P.+2.85 m (water.go.jp/kanto/kasumiga/raihou/shiru/development_project.html),
// so the lake level is the reservoir level. No live source publishes it outside
// 川の防災情報 (tool-banned); mudam's daily Y.P. series ends 2024-12-30. JWA's
// 霞ヶ浦用水管理所 (water.go.jp/kanto/kasumiy/) links 出島 as
// 「霞ヶ浦の水位状況(霞ヶ浦用水の取水地点：出島)」, and 茨城県 republishes that
// 霞ヶ浦河川事務所 station without the ban:
//
//   http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_372_1.html
//
// Shift_JIS 水位グラフ page: header 「YYYY年 MM月DD日 HH：MM 現在」, a station table
// (水系 | 河川 | 観測所名 | … | 零点高 「T.P.-0.96m」 | 雨量観測所), then 23 hourly
// rows and the latest 10-minute reading last (24 rows). Only a row that
// starts a date prints 「MM/DD  HH:MM」; 24:00 closes the day.
//
// The values are gauge heights. 「本システムでは、零点をT.P.(東京湾平均海面)で表記
// しています。Y.P.（利根川水系）=T.P.+0.8402m」 (the system's own 注意事項), and
// JWA and mudam quote the lake on Y.P., so the stored level is
// reading + 零点高 + 0.8402 m (1.51 → Y.P. 1.390 on 2026-09-28 15:50), in line
// with mudam's 2024 range of Y.P. 0.93–1.43 m. The 零点高 is read from each
// page; a page without it is refused. 出島 is one shore station, not
// 霞ヶ浦河川事務所's 湖内平均水位 (published on 川の防災情報 only).
//
// The page's 時間/累加 雨量 belong to the 霞ヶ浦庁舎 rain gauge, not the lake,
// and are not stored. No volume or rate is published.
//
// Priority 308 (prefectural 防災 tier, like ibaraki-bousai); only mudam (280,
// historical) also carries this dam. Cron hourly at :13, all 24 rows re-upserted.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.IBARAKI_KASUMIGAURA_URL ??
  'http://www.kasen.pref.ibaraki.jp/pc/graph/gra_river_372_1.html';

const SOURCE_ID = 'ibaraki-kasumigaura';
const PREF_CODE = '08';
/** The 茨城県 system's station number for 出島 (gra_river_372). */
const STATION_ID = '372';
const STATION = '出島';
const MASTER_NAME = '霞ヶ浦開発';
/** Y.P. (利根川水系) = T.P. + 0.8402 m, as the 茨城県 system states it. */
const YP_OVER_TP_M = 0.8402;

export interface DejimaGraph {
  /** 零点高 on T.P., as printed. */
  zeroTpM: number;
  /** Oldest first; level on Y.P. (m). */
  readings: { observedAt: Date; waterLevelM: number }[];
}

/** Parse the 出島 水位グラフ page; null unless it is 出島 with a 零点高. */
export function parseDejimaGraph(html: string): DejimaGraph | null {
  const head = html.match(/(\d{4})年(?:&nbsp;|\s)*(\d{2})月(\d{2})日/);
  const zero = html.match(/<td>T\.P\.([+-]?\d+(?:\.\d+)?)m(?:&nbsp;)*<\/td>/);
  if (!head || !zero || !html.includes(`<td>${STATION}</td>`)) return null;
  const headYear = Number(head[1]);
  const headMonth = Number(head[2]);
  const zeroTpM = Number(zero[1]);

  const readings: DejimaGraph['readings'] = [];
  let month = 0;
  let day = 0;
  for (const m of html.matchAll(
    /class="tblColor\d r1">((?:\d{2}\/\d{2}(?:&nbsp;)+)?)(\d{2}):(\d{2})<\/td><td nowrap="" class="r2">([^<]*)<\/td>/g,
  )) {
    const date = (m[1] ?? '').match(/(\d{2})\/(\d{2})/);
    if (date) {
      month = Number(date[1]);
      day = Number(date[2]);
    }
    if (month === 0) continue;
    const gauge = (m[4] ?? '').replace(/&nbsp;/g, '').trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(gauge)) continue;
    // A December row on a January page is last year's.
    const year = month > headMonth ? headYear - 1 : headYear;
    // Date.UTC rolls 24:00 over to the next day.
    const observedAt = new Date(Date.UTC(year, month - 1, day, Number(m[2]) - 9, Number(m[3])));
    const yp = Number(gauge) + zeroTpM + YP_OVER_TP_M;
    readings.push({ observedAt, waterLevelM: Math.round(yp * 1000) / 1000 });
  }
  return { zeroTpM, readings };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '茨城県河川情報 霞ヶ浦 出島 水位 — 霞ヶ浦開発の湖水位 (Y.P.換算, 毎時 24 時間分)',
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
      AND name = ${MASTER_NAME}
    ORDER BY id
  `;
  const dam = chooseRanked(rows, STATION_ID);
  // The one station this source reads, matched or not.
  const universe: UniverseRow[] = [
    {
      externalId: STATION_ID,
      name: `${STATION}（霞ヶ浦）`,
      prefCode: PREF_CODE,
      resolvedDamId: dam?.id ?? null,
    },
  ];
  await recordUniverse(SOURCE_ID, universe);
  if (!dam) {
    log(`${SOURCE_ID}: no master match for ${MASTER_NAME} (pref ${PREF_CODE})`);
    return null;
  }
  await bindExternalId(dam.id, SOURCE_ID, STATION_ID);
  return dam.id;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Resolved before the fetch: the station is published whether or not this
  // run's page loads, and the universe must say so.
  const damId = await findDamId(log);

  const res = await fetch(PAGE_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const graph = parseDejimaGraph(new TextDecoder('shift_jis').decode(await res.arrayBuffer()));
  if (!graph) {
    throw new Error(`${SOURCE_ID}: page is not the 出島 graph with a 零点高; layout changed?`);
  }
  if (!damId) return;

  const written = await upsertObservations(
    graph.readings.map((r) => ({
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
  log(
    `${SOURCE_ID} done: parsed=${graph.readings.length} matched=1 written=${written} zero=T.P.${graph.zeroTpM}`,
  );
};

export default task;
