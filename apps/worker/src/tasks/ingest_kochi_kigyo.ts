// apps/worker/src/tasks/ingest_kochi_kigyo.ts
//
// 高知県公営企業局 発電所集中監視制御Webシステム ダム水文量表 — 2 発電専用ダム
// on the 物部川: 吉野ダム and 杉田ダム. Neither is in kochi-bousai's ダム諸量
// or any other feed; the bureau publishes them under the 物部川水系治水協定
// (https://www.pref.kochi.lg.jp/doc/denki_dam_info/).
//
// Source:
//   http://210.155.220.59/web/crt17/01/01
//   (UTF-8 HTML; plain GET, no session needed. Default view is 本日 / 1時間:
//   the last 48 hourly rows, oldest first.)
//
// Table: header row 1 names each dam (<th colspan="5">), header row 2 labels
// its columns 貯水位(EL.m) | 流入量(m3/s) | 放流量(m3/s) | 雨量(mm) | 累計雨量(mm).
// Each data row carries td.col_time "YYYY-MM-DD HH:MM:SS.0" (JST) and then
// td.info values for every dam in header order. No volume or rate is
// published. The site calls the values 瞬時値 that may differ from the
// official record, so they are stored as published; 流入量 can be slightly
// negative (-0.8) when the back-calculated inflow dips. Any non-numeric cell
// is read as null, and an hour with no level, inflow or outflow for a dam is
// dropped: the page re-serves 48 hours every run, so an outage row would
// otherwise overwrite an hour already stored with values.
//
// Priority 308, the prefectural tier; no other source covers either dam.
// Cron hourly at :54.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.KOCHI_KIGYO_DAM_URL ?? 'http://210.155.220.59/web/crt17/01/01';

const PREF_CODE = '39';
const SOURCE_ID = 'kochi-kigyo';

// --- parsing ----------------------------------------------------------------

export interface KochiKigyoReading {
  /** Dam name as published ("杉田ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** That hour's 雨量, not the 累計雨量 column. */
  rainfallMm: number | null;
}

export interface KochiKigyoTable {
  /** Every dam the table publishes, in column order. */
  dams: string[];
  readings: KochiKigyoReading[];
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .trim();
}

function cellValue(cell: string | undefined): number | null {
  const text = cellText(cell ?? '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

export function parseKochiKigyoTable(html: string): KochiKigyoTable {
  const start = html.indexOf('<table class="OddEven">');
  if (start < 0) return { dams: [], readings: [] };
  const end = html.indexOf('</table>', start);
  const table = html.slice(start, end < 0 ? undefined : end);

  const dams: { name: string; span: number }[] = [];
  const labels: string[] = [];
  const rows: { observedAt: Date; values: string[] }[] = [];
  for (const tr of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const time = body.match(
      /<td[^>]*class="col_time"[^>]*>\s*(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/,
    );
    if (time) {
      const observedAt = new Date(
        Date.UTC(
          Number(time[1]),
          Number(time[2]) - 1,
          Number(time[3]),
          Number(time[4]) - 9,
          Number(time[5]),
        ),
      );
      const values = [...body.matchAll(/<td[^>]*class="info"[^>]*>([\s\S]*?)<\/td>/g)].map(
        (c) => c[1] ?? '',
      );
      rows.push({ observedAt, values });
      continue;
    }
    for (const th of body.matchAll(/<th([^>]*)>([\s\S]*?)<\/th>/g)) {
      const attrs = th[1] ?? '';
      const text = cellText(th[2] ?? '');
      const span = attrs.match(/colspan="(\d+)"/i);
      if (span) dams.push({ name: text, span: Number(span[1]) });
      else if (!/rowspan/i.test(attrs)) labels.push(text);
    }
  }

  const readings: KochiKigyoReading[] = [];
  let offset = 0;
  for (const dam of dams) {
    const block = labels.slice(offset, offset + dam.span);
    const col = (re: RegExp): number => {
      const i = block.findIndex((l) => re.test(l));
      return i < 0 ? -1 : offset + i;
    };
    const level = col(/^貯水位/);
    const inflow = col(/^流入量/);
    const outflow = col(/^放流量/);
    const rain = col(/^雨量/);
    for (const r of rows) {
      const waterLevelM = cellValue(r.values[level]);
      const inflowM3s = cellValue(r.values[inflow]);
      const outflowM3s = cellValue(r.values[outflow]);
      if (waterLevelM === null && inflowM3s === null && outflowM3s === null) continue;
      readings.push({
        name: dam.name,
        observedAt: r.observedAt,
        waterLevelM,
        inflowM3s,
        outflowM3s,
        rainfallMm: cellValue(r.values[rain]),
      });
    }
    offset += dam.span;
  }
  return { dams: dams.map((d) => d.name), readings };
}

// --- matching ---------------------------------------------------------------

function stem(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/**
 * The master row for a published dam name: the row stamped with it, else an
 * exact stem match, with a （元）/（再） pair settled by preferMaster. No
 * prefix fallback — 吉野 would otherwise land on the agricultural 吉野溜池.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const target = stem(name);
  const candidates = masters
    .filter((m) => m.stamp === name || stem(m.name) === target)
    .map((m) => ({ ...m, rank: 0 }));
  return chooseRanked(candidates, name)?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '高知県公営企業局 ダム水文量表 — 吉野/杉田ダム (UTF-8 HTML, 時次)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(dams: string[], log: (s: string) => void): Promise<Map<string, bigint>> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  const universe: UniverseRow[] = [];

  for (const name of dams) {
    const damId = chooseMaster(name, masters);
    universe.push({ externalId: name, name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${name}"`);
      continue;
    }
    damByName.set(name, damId);
    await bindExternalId(damId, SOURCE_ID, name);
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

  const { dams, readings } = parseKochiKigyoTable(await r.text());
  log(`${SOURCE_ID}: parsed ${dams.length} dams, ${readings.length} readings`);

  const damByName = await matchMaster(dams, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of readings) {
    const damId = damByName.get(p.name);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: p.inflowM3s,
      outflowM3s: p.outflowM3s,
      waterLevelM: p.waterLevelM,
      rainfallMm: p.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: parsed=${dams.length} matched=${damByName.size} readings=${readings.length} written=${written}`,
  );
};

export default task;
