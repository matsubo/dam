// apps/worker/src/tasks/ingest_shiga.ts
//
// 滋賀県土木防災情報システム ダム観測情報 — hourly + latest 10-minute values.
//
// Source (Shift_JIS HTML, the site's mobile pages):
//   https://shiga-bousai.jp/mobile/dam/dam_select.php         観測局一覧 (11 stations)
//   https://shiga-bousai.jp/mobile/dam/dam_data.php?ID={id}   one station
// shiga-bousai.jp/robots.txt disallows /dam/ (the desktop dam_table.php this
// task used to read) and explicitly allows /mobile/, so only /mobile/ is read.
//
// 観測局一覧: "◆<a href="dam_data.php?ID=34191&datetime=…">青土ダム</a>" per
// station. Published 2026-09-27: 青土 / 日野川 / 永源寺 / 野洲川 / 蔵王 / 犬上川 /
// 宇曽川 / 姉川 / 余呉湖 / 石田川 / 天川. 余呉湖 and 天川 have no master dam;
// 犬上川 is listed with a 0.00 placeholder and a page with no rows at all.
//
// dam_data.php: the latest 10-minute row then six hourly rows, newest first:
//   <p>MM/DD HH:MM<br>［貯水位］369.23<br>［流入量］1.67<br>［放流量］2.19<br>
//      ［60分間雨量］0<br>［累加雨量］12</p>
// Units per the page legend: 貯水位 m (EL), 流入量 / 放流量 m³/s; rainfall mm.
// "*" 欠測 and "-" 未観測 → null. Rows carry no year: it is the reference
// time's JST year, or the previous one for a row that would lie in the future
// (12/31 rows read just after New Year). A row with level and both flows
// missing is dropped rather than written empty.
//
// No 貯水量 / 貯水率 is published. Priority 308. Cron hourly at :07; each run
// re-upserts the six-hour window so short outages self-heal.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.SHIGA_BOUSAI_BASE ?? 'https://shiga-bousai.jp';

const SOURCE_ID = 'shiga-bousai';
const PREF_CODE = '25';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

export interface Station {
  id: string;
  /** Name as the 観測局一覧 prints it — the universe key and the stamp. */
  name: string;
}

export interface ParsedRow {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  rainfallMm: number | null;
}

/** Every station on the 観測局一覧, in page order. */
export function parseShigaStationList(html: string): Station[] {
  return [...html.matchAll(/◆<a href="dam_data\.php\?ID=(\d+)[^"]*">([^<]+)<\/a>/g)].flatMap((m) =>
    m[1] && m[2] ? [{ id: m[1], name: m[2].trim() }] : [],
  );
}

/** "［label］value" cell → number; "*" 欠測, "-" 未観測 and blanks → null. */
function field(block: string, label: string): number | null {
  const raw = block.match(new RegExp(`［${label}］([^<]*)`))?.[1]?.trim() ?? '';
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const JST_OFFSET_MS = 9 * 3600 * 1000;

export function parseShigaDamData(html: string, reference: Date): ParsedRow[] {
  const refYear = new Date(reference.getTime() + JST_OFFSET_MS).getUTCFullYear();
  const out: ParsedRow[] = [];
  for (const m of html.matchAll(/<p>(\d{2})\/(\d{2}) (\d{2}):(\d{2})<br>([\s\S]*?)<\/p>/g)) {
    const [, mo, dy, hh, mi, block = ''] = m;
    const at = (year: number) =>
      new Date(Date.UTC(year, Number(mo) - 1, Number(dy), Number(hh), Number(mi)) - JST_OFFSET_MS);
    const thisYear = at(refYear);
    const observedAt =
      thisYear.getTime() > reference.getTime() + 24 * 3600 * 1000 ? at(refYear - 1) : thisYear;
    const row = {
      observedAt,
      waterLevelM: field(block, '貯水位'),
      inflowM3s: field(block, '流入量'),
      outflowM3s: field(block, '放流量'),
      rainfallMm: field(block, '60分間雨量'),
    };
    if (row.waterLevelM === null && row.inflowM3s === null && row.outflowM3s === null) continue;
    out.push(row);
  }
  return out;
}

/**
 * Whether a station page carries any reading: true = rows we store; false =
 * a recognised station page whose every level / flow is "*" 欠測 or "-"
 * 未観測, or 犬上川's exact shape (the 現在 header straight into the legend
 * <hr>, no rows at all); null = anything else, which may be an error page or
 * a redesign rather than the provider publishing nothing.
 */
export function shigaPageHasData(html: string): boolean | null {
  if (!/\d{2}月\d{2}日 \d{2}時\d{2}分現在/.test(html)) return null;
  if (parseShigaDamData(html, new Date()).length > 0) return true;
  const cells = [...html.matchAll(/［(?:貯水位|流入量|放流量)］([^<]*)/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
  if (cells.length === 0) return /分現在<br>\s*<hr>/.test(html) ? false : null;
  return cells.every((c) => c === '' || c === '*' || c === '-') ? false : null;
}

async function fetchShiftJis(url: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) return null;
  return new TextDecoder('shift_jis').decode(await r.arrayBuffer());
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '滋賀県土木防災情報システム (mobile) — hourly, 8 dams (青土/日野川/永源寺/野洲川/蔵王/宇曽川/姉川/石田川)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMasters(
  stations: Station[],
  log: (s: string) => void,
): Promise<{ damById: Map<string, bigint>; universe: UniverseRow[] }> {
  const damById = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const s of stations) {
    const stem = s.name.replace(/ダム$/, '');
    // Exact name, then "…ダム", then either twin of a redeveloped dam (ranked
    // alike so chooseRanked binds the current one). No bare substring match:
    // 日野川 must not fall through to 日野川脇. A stamped row keeps it (#79).
    const rows = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>${SOURCE_ID} AS stamp,
             CASE
               WHEN name = ${stem} THEN 0
               WHEN name = ${`${stem}ダム`} THEN 1
               ELSE 2
             END AS rank
      FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND (name IN (${stem}, ${`${stem}ダム`})
             OR name LIKE ${`${stem}（再）%`}
             OR name LIKE ${`${stem}（元）%`}
             OR external_ids->>${SOURCE_ID} = ${s.name})
      ORDER BY rank, id
    `;
    const r = chooseRanked(rows, s.name);
    universe.push({
      externalId: s.name,
      name: s.name,
      prefCode: PREF_CODE,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`${SOURCE_ID}: no master match for ${s.name}`);
      continue;
    }
    damById.set(s.id, r.id);
    await bindExternalId(r.id, SOURCE_ID, s.name);
  }
  return { damById, universe };
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const listHtml = await fetchShiftJis(`${BASE_URL}/mobile/dam/dam_select.php`);
  if (listHtml === null) {
    log(`${SOURCE_ID}: station list unavailable; aborting`);
    return;
  }
  const stations = parseShigaStationList(listHtml);
  const { damById, universe } = await matchMasters(stations, log);
  log(`${SOURCE_ID}: matched ${damById.size}/${stations.length} stations`);

  let parsed = 0;
  let written = 0;
  // Keyed by the universe's external id (the printed name). Only matched
  // stations are fetched, so an unmatched one stays unknown — it has no dam
  // for /coverage to classify anyway.
  const hasDataByName = new Map<string, boolean | null>();
  for (const s of stations) {
    const damId = damById.get(s.id);
    if (!damId) continue;
    try {
      const html = await fetchShiftJis(`${BASE_URL}/mobile/dam/dam_data.php?ID=${s.id}`);
      if (html === null) {
        log(`${SOURCE_ID}: ${s.name} unavailable; skip`);
        continue;
      }
      const rows = parseShigaDamData(html, new Date());
      hasDataByName.set(s.name, shigaPageHasData(html));
      parsed += rows.length;
      const n = await upsertObservations(
        rows.map((row) => ({
          observedAt: row.observedAt,
          damId,
          sourceId: SOURCE_ID,
          storageVolumeM3: null,
          storageRate: null,
          inflowM3s: row.inflowM3s,
          outflowM3s: row.outflowM3s,
          waterLevelM: row.waterLevelM,
          rainfallMm: row.rainfallMm,
          rawSnapshotId: null,
          qualityFlag: 0,
        })),
      );
      written += n;
      log(`${SOURCE_ID}: ${s.name} +${n} rows`);
    } catch (e) {
      log(`${SOURCE_ID}: ${s.name} ERROR ${(e as Error).message}`);
    }
  }

  // Recorded after the station pages, which are what say whether a listed
  // station carries any value.
  await recordUniverse(
    SOURCE_ID,
    universe.map((u) => ({ ...u, hasData: hasDataByName.get(u.externalId) ?? null })),
  );
  log(`${SOURCE_ID} done: parsed=${parsed} matched=${damById.size} written=${written}`);
};

export default task;
