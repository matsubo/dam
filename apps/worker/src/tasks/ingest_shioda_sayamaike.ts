// apps/worker/src/tasks/ingest_shioda_sayamaike.ts
//
// 上田市塩田平土地改良区 (水土里ネット塩田平)「沢山池の状況図」 — 沢山池 (長野県上田市,
// NDI 961, 総貯水量 1,082 千m³), every 10 minutes.
//
// Source: the 状況図 page http://www.midorinet-shioda.or.jp/reservoir/sayamaike/
// fills its table from one CSV, data/SFTP.csv: a single CRLF line of 12
// comma-separated fields, in the order the page's script reads them
// (2026-09-28):
//   0 現在貯水位 (E.L.m)    1 総貯水量 (m³, static)  2 現在貯水量 (m³)
//   3 現在貯水率 (%, integer)  4–6 利水放流 / 洪水吐放流 / 全放流量 (m³/s)
//   7 全流入量 (m³/s)  8 時間雨量 (mm)  9 累計雨量 (mm)  10 外気温 (℃)
//   11 index of the water-level picture
// The page stopped showing fields 4–6 on 2026-03-13 (「非表示20260313」 in its
// script), so no outflow is stored. The 常時満水位 on the page is 600.00 E.L.m.
//
// Time: the CSV carries none, and the page's 「現在」 time comes from a script
// that returns the server's clock. The file is re-uploaded (by SFTP, per its
// name) about a minute past every 10-minute mark: Last-Modified 06:51:10 and
// 07:01:10 GMT on 2026-09-28. A reading is stamped at its Last-Modified
// floored to the 10-minute mark.
//
// Rate: 貯水率 is 現在貯水量 / 総貯水量 as a whole percent (86,035 /
// 1,082,409 = 7.9 % → 8), i.e. on the total, not the 有効 995 千m³ of the
// master; it is stored as published and not trusted, so the site divides the
// volume by the master's capacity.
//
// License: the site states no terms of use; every page carries
// 「copyright © 上田市塩田平土地改良区 All Rights Reserved.」 robots.txt returns 404.
// Only the observed numbers are stored, with the source named.
//
// Priority 285. No other source publishes 沢山池. Cron hourly at :05.

import { type BindableMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const SOURCE_ID = 'shioda-sayamaike';
const CSV_URL =
  process.env.SHIODA_SAYAMAIKE_URL ??
  'http://www.midorinet-shioda.or.jp/reservoir/sayamaike/data/SFTP.csv';
const NAME = '沢山池';
const PREF_CODE = '20';
const TEN_MINUTES_MS = 10 * 60_000;

export interface SayamaikeReading {
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  /** 0..1 */
  storageRate: number | null;
  inflowM3s: number | null;
  rainfallMm: number | null;
}

/** The CSV line and the response's Last-Modified → one reading. Throws on a layout change. */
export function parseSayamaikeCsv(csv: string, lastModified: string | null): SayamaikeReading {
  const fields = csv.trim().split(',');
  if (fields.length < 12) {
    throw new Error(`${SOURCE_ID}: expected 12 CSV fields, got ${fields.length} — layout change?`);
  }
  const modified = lastModified ? Date.parse(lastModified) : Number.NaN;
  if (Number.isNaN(modified)) {
    throw new Error(
      `${SOURCE_ID}: no usable Last-Modified (${lastModified}); cannot date the reading`,
    );
  }
  const num = (i: number): number | null => {
    const s = (fields[i] ?? '').trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const rate = num(3);
  return {
    observedAt: new Date(Math.floor(modified / TEN_MINUTES_MS) * TEN_MINUTES_MS),
    waterLevelM: num(0),
    storageVolumeM3: num(2),
    storageRate: rate === null ? null : rate / 100,
    inflowM3s: num(7),
    rainfallMm: num(8),
  };
}

/** Bind and stamp the 長野 沢山池; null when the master has no single one. */
export async function matchSayamaike(log: (s: string) => void): Promise<bigint | null> {
  const candidates = await sql<BindableMaster[]>`
    SELECT id, name, external_ids->>${SOURCE_ID} AS stamp
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND (name = ${NAME} OR external_ids->>${SOURCE_ID} = ${NAME})
  `;
  const master =
    stampedMaster(candidates, NAME) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!master) {
    log(`${SOURCE_ID}: ${candidates.length} master rows for ${NAME} in ${PREF_CODE}; not binding`);
    return null;
  }
  await bindExternalId(master.id, SOURCE_ID, NAME);
  return master.id;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 285,
            '上田市塩田平土地改良区 沢山池の状況図 — 沢山池 (貯水位・貯水量・貯水率・流入量, 10 分毎)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(CSV_URL, {
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
  const reading = parseSayamaikeCsv(await r.text(), r.headers.get('last-modified'));
  const hasValue =
    reading.waterLevelM !== null ||
    reading.storageVolumeM3 !== null ||
    reading.storageRate !== null ||
    reading.inflowM3s !== null;

  // The provider publishes this one reservoir; recorded so /coverage can say
  // "they publish it, we failed to link it" instead of guessing.
  const damId = await matchSayamaike(log);
  await recordUniverse(SOURCE_ID, [
    {
      externalId: NAME,
      name: NAME,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      hasData: hasValue ? true : null,
    },
  ]);
  if (!damId || !hasValue) {
    log(`${SOURCE_ID} done: parsed=1 matched=${damId ? 1 : 0} written=0`);
    return;
  }

  const written = await upsertObservations([
    {
      observedAt: reading.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: reading.storageVolumeM3,
      storageRate: reading.storageRate,
      inflowM3s: reading.inflowM3s,
      outflowM3s: null, // the release columns are no longer shown on the page
      waterLevelM: reading.waterLevelM,
      rainfallMm: reading.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(
    `${SOURCE_ID} done at ${reading.observedAt.toISOString()}: parsed=1 matched=1 written=${written}`,
  );
};

export default task;
