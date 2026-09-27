// apps/worker/src/tasks/ingest_cgr_ashida_seki.ts
//
// 国土交通省 中国地方整備局 福山河川国道事務所 — 芦田川河口堰 (芦田川水系,
// 広島/34). The weir is a master dam row (NDI 1908, 有効貯水容量 4,960 千m³)
// that no other live source publishes; mudam only carries its 1-2 year old
// daily figures.
//
// Source: the office's 芦田川水系 水文データ page (mobile HTML, UTF-8 with BOM),
// a single snapshot refreshed every 10 minutes:
//   http://www.cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php
//
//   観測日時: YYYY/MM/DD<br>HH:MM   (JST)
//   ■ 芦田川河口堰諸量, one <tr> per item:
//     流入量   m³/s  → inflow
//     放流量   m³/s  → outflow
//     貯水量   千m³  → storage volume (× 1000 = m³)
//     堰上水位 m     → water level (the pool side of the weir)
//     堰下水位 / 堰取水量 — not stored
//   No 貯水率 is published; storage_rate stays NULL and is derived from the
//   volume like any other untrusted source.
//
// Licence: 中国地方整備局 site terms — 公共データ利用規約（第1.0版）(PDL1.0),
// 出典記載のうえ利用可 (www.cgr.mlit.go.jp/about_manual/).
//
// Priority 303 (MLIT office source, same as qsr-ryumon-dam). Cron hourly at :54.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.CGR_ASHIDA_SEKI_URL ??
  'http://www.cgr.mlit.go.jp/fukuyama/mobile_ashidagawa/sekisyoryou.php';

const SOURCE_ID = 'cgr-ashida-seki';
const PREF_CODE = '34';
/** The page publishes one facility and no station code; its name is the key. */
const STATION = '芦田川河口堰';

export interface AshidaReading {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
}

function parseNum(s: string | undefined): number | null {
  const t = (s ?? '')
    .replace(/<[^>]+>|&nbsp;/g, '')
    .replace(/,/g, '')
    .trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Parse the 水文データ page; null when it carries no 観測日時. */
export function parseAshidaSekiHtml(html: string): AshidaReading | null {
  const ts = html.match(/観測日時:\s*(\d{4})\/(\d{2})\/(\d{2})\s*<br\s*\/?>\s*(\d{2}):(\d{2})/);
  if (!ts) return null;
  const observedAt = new Date(
    Date.UTC(Number(ts[1]), Number(ts[2]) - 1, Number(ts[3]), Number(ts[4]) - 9, Number(ts[5])),
  );

  const values: Record<string, number | null> = {};
  for (const m of html.matchAll(
    /<td class="name">([^<]+)<\/td>\s*<td class="data"[^>]*>([\s\S]*?)<\/td>/g,
  )) {
    values[(m[1] ?? '').trim()] = parseNum(m[2]);
  }

  const storageThousandM3 = values.貯水量 ?? null;
  return {
    observedAt,
    waterLevelM: values.堰上水位 ?? null,
    inflowM3s: values.流入量 ?? null,
    outflowM3s: values.放流量 ?? null,
    storageVolumeM3: storageThousandM3 !== null ? storageThousandM3 * 1000 : null,
  };
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 303,
            '国土交通省 中国地方整備局 福山河川国道事務所 — 芦田川河口堰 (芦田川水系, 10分更新 HTML)',
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
           external_ids->>${SOURCE_ID} AS stamp,
           CASE WHEN name = ${STATION} THEN 0 ELSE 1 END AS rank
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND name LIKE '芦田川%堰%'
    ORDER BY rank, id
  `;
  const dam = chooseRanked(rows, STATION);
  // The one facility this page publishes, matched or not, so /coverage can
  // tell "published, not linked" from "nobody publishes it".
  const universe: UniverseRow[] = [
    { externalId: STATION, name: STATION, prefCode: PREF_CODE, resolvedDamId: dam?.id ?? null },
  ];
  await recordUniverse(SOURCE_ID, universe);
  if (!dam) {
    log(`${SOURCE_ID}: no master match for ${STATION} (pref ${PREF_CODE})`);
    return null;
  }
  await bindExternalId(dam.id, SOURCE_ID, STATION);
  return dam.id;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  // Resolved before the fetch: the office publishes the weir whether or not
  // this run's page loads, and the universe must say so.
  const damId = await findDamId(log);

  const res = await fetch(PAGE_URL, {
    headers: { 'user-agent': ua },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status !== 200) {
    log(`${SOURCE_ID}: HTTP ${res.status}; abort`);
    return;
  }
  const reading = parseAshidaSekiHtml(await res.text());
  if (!reading) {
    log(`${SOURCE_ID}: no 観測日時 on the page; abort`);
    return;
  }
  const { observedAt, waterLevelM, inflowM3s, outflowM3s, storageVolumeM3 } = reading;
  if (
    waterLevelM === null &&
    inflowM3s === null &&
    outflowM3s === null &&
    storageVolumeM3 === null
  ) {
    log(`${SOURCE_ID}: all values missing at ${observedAt.toISOString()}; skip`);
    return;
  }
  if (!damId) return;

  const written = await upsertObservations([
    {
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3,
      storageRate: null,
      inflowM3s,
      outflowM3s,
      waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    },
  ]);
  log(`${SOURCE_ID} done: parsed=1 matched=1 written=${written} at ${observedAt.toISOString()}`);
};

export default task;
