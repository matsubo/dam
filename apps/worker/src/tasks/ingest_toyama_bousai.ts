// apps/worker/src/tasks/ingest_toyama_bousai.ts
//
// 富山県 河川現況表 ダム貯水位表 — 16 県管理ダム, 10-min telemetry.
//
//   室牧/上市川/和田川/利賀川/白岩川/子撫川/角川/熊野川/上市川第二/朝日小川/
//   布施川/城端/境川/大谷/久婦須川/舟川
//
// Page: https://kawa.pref.toyama.jp/camera/02condlist.html?id=0&sel=3 renders
// in the browser from two CSVs next to it (UTF-8, CRLF, no header):
//
//   data/damname_data.csv  code, ダム名, 水系名, 川の防災情報 URL, season flag,
//                          season start, season end, 貯水率 shown (1/0)
//   data/dam_data.csv      code, YYYY/MM/DD, HH:MM (JST, per dam), 貯水位 m,
//                          trend, 全流入量, 全放流量, 貯水率 利水容量 %,
//                          貯水率 有効容量 %, (unused)
//
// The page labels the two rate columns 「貯水率 利水容量(％)」 and
// 「貯水率 有効容量(％)」 and prints － for both where the shown flag is 0
// (熊野川, 朝日小川). Missing values: 貯水位 -9999.99, flows -99999.99,
// rates -99.9. Three stations' flows are not stored in m³/s; see FLOW_FIX.
//
// This replaced the Salesforce 県内ダム情報実況表 (hourly, no 貯水率): the same
// 16 dams under the same names, plus both rates and a per-dam time. Levels and
// (scaled) flows equal MLIT 川の防災情報's for the same stations and minutes.
//
// storageRate is the 利水容量 column. Checked at the 2026-09-27 16:30 JST
// update against MLIT 川の防災情報 (gjson/obs/…/dam/1601.json → tmlist/dam):
// both rate columns equal its storPcntIrr / storPcntEff on all 12 dams where
// both publish one, and its 貯水量 divided by the 利水 rate lands below the
// annual 有効 capacity — a season pool — while the 有効 column back-solves to
// the annual figure:
//
//   室牧     4,432 千m³ / 66.3 % = 6,685  (有効 13,500; ÷36.6 % = 12,109)
//   上市川     792 / 57.9 % = 1,368      (3,500)
//   上市川第二 972 / 58.6 % = 1,659      (4,700)
//   白岩川     194 / 48.2 % =   402      (1,700)
//   和田川     669 / 74.5 % =   898      (1,900)
//   境川    22,283 / 45.7 % = 48,759     (56,100)
//
// Not trusted_rate_basis anyway: this feed has no 貯水量, so
// effective_active_capacity_m3() has nothing to back-solve from it. And
// display_observation() ranks any current trusted row with a native rate
// first, newest first — these volume-less 10-minute rows would then displace
// kasenbosai's trusted rows (which carry the 貯水量) on the dam page and blank
// its 貯水量 / 貯水率.
//
// A 貯水率 on a row whose 貯水位 is 欠測 is dropped: 城端 and 利賀川 carried
// 18.8 / 15.4 % that way while MLIT flagged the same readings missing.
// Priority 308.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_BASE = process.env.TOYAMA_BOUSAI_DATA_BASE ?? 'https://kawa.pref.toyama.jp/camera/data';

const PREF_CODE = '16';
const SOURCE_ID = 'toyama-bousai';

// Flow columns not stored in m³/s, converted exactly as the page's own
// scripts do before rendering (both under kawa.pref.toyama.jp/camera/contents/):
//
// - 002_header.js DamListData(): 利賀川 (0090004) and 角川 (0020007) render
//   as Math.round(v*100)/10 — 角川 0.04 → 0.40, as MLIT 川の防災情報 reads.
// - fileaccess.js DAMZenryuunyuuCalc(), run from Make_GENSUICyuiKeikai() on
//   02condlist.html: 舟川 (0030016) is rewritten to Math.floor(v*10)/100 —
//   2.11 → 0.21 at 16:30 JST on 2026-09-27, as MLIT read for the same minute.
const FLOW_FIX: Record<string, (v: number) => number> = {
  '0090004': (v) => Math.round(v * 100) / 10,
  '0020007': (v) => Math.round(v * 100) / 10,
  '0030016': (v) => Math.floor(v * 10) / 100,
};

// --- types ------------------------------------------------------------------

export interface ToyamaStation {
  code: string;
  toyamaName: string;
  /** The page prints 貯水率 for this dam (damname_data.csv column 8). */
  ratePublished: boolean;
}

export interface ParsedRow {
  toyamaName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  /** 貯水率 利水容量, 0..1. */
  storageRate: number | null;
}

// --- parsing ----------------------------------------------------------------

function csvRows(csv: string): string[][] {
  return csv
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => line.split(',').map((c) => c.trim()));
}

/** A number, or null when missing or at/below the upstream's 欠測 sentinel. */
function reading(s: string | undefined, missingAtOrBelow: number): number | null {
  if (s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n > missingAtOrBelow ? n : null;
}

/** damname_data.csv — the provider's whole published list, in page order. */
export function parseToyamaStations(csv: string): ToyamaStation[] {
  const out: ToyamaStation[] = [];
  for (const c of csvRows(csv)) {
    const [code, toyamaName, , , , , , shown] = c;
    if (!code || !toyamaName) continue;
    out.push({ code, toyamaName, ratePublished: shown === '1' });
  }
  return out;
}

/** dam_data.csv joined to the station list by code. */
export function parseToyamaDamData(csv: string, stations: ToyamaStation[]): ParsedRow[] {
  const byCode = new Map(stations.map((s) => [s.code, s]));
  const rows: ParsedRow[] = [];
  for (const c of csvRows(csv)) {
    const [code, date, time, level, , inflow, outflow, rateIrr] = c;
    const station = code ? byCode.get(code) : undefined;
    if (!station) continue;
    const dm = date?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const tm = time?.match(/^(\d{2}):(\d{2})$/);
    if (!dm || !tm) continue;
    const observedAt = new Date(
      Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]) - 9, Number(tm[2])),
    );

    const waterLevelM = reading(level, -9999.99);
    const fix = FLOW_FIX[station.code];
    const flow = (s: string | undefined): number | null => {
      const v = reading(s, -99999.99);
      return v !== null && fix ? fix(v) : v;
    };
    const inflowM3s = flow(inflow);
    const outflowM3s = flow(outflow);
    const pct = station.ratePublished && waterLevelM !== null ? reading(rateIrr, -99.9) : null;
    const storageRate = pct === null ? null : pct / 100;

    if (waterLevelM === null && inflowM3s === null && outflowM3s === null && storageRate === null) {
      continue;
    }
    rows.push({
      toyamaName: station.toyamaName,
      observedAt,
      waterLevelM,
      inflowM3s,
      outflowM3s,
      storageRate,
    });
  }
  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '富山県 河川現況表 ダム貯水位表 — 16 ダム (kawa.pref.toyama.jp CSV, 10分更新, 貯水率 利水容量)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return (
    s
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/ダム$/, '')
      .replace(/貯水池$/, '')
      // Normalise 第N kanji numerals → Arabic so "第二" matches master "第2".
      .replace(/第一/g, '第1')
      .replace(/第二/g, '第2')
      .replace(/第三/g, '第3')
      .replace(/第四/g, '第4')
      .replace(/第五/g, '第5')
      .trim()
  );
}

/**
 * Best master dam for a published dam name. The name is also the station's
 * stamp, so a row already stamped with it keeps it (#57); otherwise exact name
 * beats stem beats prefix beats substring, and a tie goes to the current
 * （元）/（再） twin.
 */
export function chooseMaster(toyamaName: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, toyamaName);
  if (stamped) return stamped.id;
  const stem = normalizeName(toyamaName);
  if (!stem) return null;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === toyamaName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && preferMaster(m, best.m))) {
      best = { m, rank };
    }
  }
  return best?.m.id ?? null;
}

interface DamMatch {
  toyamaName: string;
  damId: bigint;
}

/** Binds each published dam and records the whole published list. */
async function matchMaster(
  stations: ToyamaStation[],
  log: (s: string) => void,
): Promise<DamMatch[]> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of stations) {
    if (!normalizeName(r.toyamaName)) continue;
    const damId = chooseMaster(r.toyamaName, masters);
    universe.push({
      externalId: r.toyamaName,
      name: r.toyamaName,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${r.toyamaName}"`);
      continue;
    }
    out.push({ toyamaName: r.toyamaName, damId });
    await bindExternalId(damId, SOURCE_ID, r.toyamaName);
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
}

// --- task -------------------------------------------------------------------

async function fetchCsv(file: string, log: (s: string) => void): Promise<string | null> {
  const r = await fetch(`${DATA_BASE}/${file}`, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`${SOURCE_ID}: ${file} HTTP ${r.status}; aborting`);
    return null;
  }
  return r.text();
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const namesCsv = await fetchCsv('damname_data.csv', log);
  if (namesCsv === null) return;
  const dataCsv = await fetchCsv('dam_data.csv', log);
  if (dataCsv === null) return;

  const stations = parseToyamaStations(namesCsv);
  const rows = parseToyamaDamData(dataCsv, stations);
  log(`${SOURCE_ID}: ${stations.length} published dams, ${rows.length} with readings`);

  const matches = await matchMaster(stations, log);
  const damByName = new Map(matches.map((m) => [m.toyamaName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.toyamaName);
    if (!damId) continue;
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

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${matches.length} written=${written}`);
};

export default task;
