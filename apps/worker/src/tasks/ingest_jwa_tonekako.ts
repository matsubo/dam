// apps/worker/src/tasks/ingest_jwa_tonekako.ts
//
// 水資源機構 利根川河口堰管理所 — 利根河口堰 情報提供 (hourly, 24 h rolling).
//
// Source: https://tonekako.sakura.ne.jp/ — linked as 「利根川河口堰」 from JWA's
// リアルタイム水源情報 (water.go.jp/honsya/honsya/suigen/realtime/index.html)
// and from the 管理所's own top page. The 水位表 / 流量表 screens load plain
// script files the page evals:
//
//   json/online/J225360003.js  正時水位表 (Y.P.m)
//     銚子 -1.0km | 新田 18.0km | 新宿 19.0km | 阿玉川 26.0km | 操作タイプ |
//     黒部下流 | 黒部上流 | 黒部（阿玉川）
//   json/online/J225460003.js  正時流量表
//     堰流入量 m³/s | 堰通過流量 m³/s | 順流総量 10³m³ | 逆流総量 10³m³ |
//     操作タイプ | 霞ヶ浦導送水 m³/s | 黒部 通過流量 m³/s | 黒部 順流総量 10³m³
//
// Each is `JsonData = eval({'NewTime':"YYYY/MM/DD HH:MM:SS", 'HyoAll':[…]})`:
// one ColumnList of 24 cells, oldest first, with no per-row time. The page
// labels row i NewTime − (23 − i) h (CmnView.makeTimeData), JST.
//
// The weir sits at 18.5 km, so 新宿 19.0km is its pool (the 管理所's daily
// kanri/data.html calls the 9時 reading 堰上流水位) and 新田 18.0km is 堰下流.
// Levels are stored as published, on the Y.P. datum (T.P. + 0.84 m) the
// manager uses. 堰通過流量 prints ** while the gates are open; ** is null.
// Cell colours only flag threshold exceedances (red) and are ignored. No
// volume or rate is published — the weir is a tidal barrage, not storage.
//
// Only this facility is a dam in the master; 黒部川水門, on the same screens,
// is a sluice gate and is not listed in the universe.
//
// Priority 298 (JWA realtime tier, cf. jwa-toyokawa). Nothing else carries
// live data for 利根川河口堰; mudam's rows are historical. Cron hourly at :54.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const BASE_URL = process.env.JWA_TONEKAKO_BASE_URL ?? 'https://tonekako.sakura.ne.jp/json/online';
const SUII_FILE = 'J225360003.js';
const RYURYO_FILE = 'J225460003.js';

const SOURCE_ID = 'jwa-tonekako';
/** Station key: the facility's name as JWA lists it. */
const STATION = '利根川河口堰';
/** The weir spans the 茨城 / 千葉 border; the master files it under 茨城. */
const PREF_CODES = ['08', '12'];

const COLUMNS = 8;
const SUII_UPSTREAM_COL = 2; // 新宿 19.0km
const RYURYO_INFLOW_COL = 0; // 堰流入量
const RYURYO_THROUGH_COL = 1; // 堰通過流量

// --- parsing ----------------------------------------------------------------

export interface HourlyTable {
  /** Row times, oldest first. */
  observedAt: Date[];
  /** columns[c][row]; ** and blanks are null. */
  columns: (number | null)[][];
}

interface HyoCell {
  PropertyList?: Array<{ Name?: string; Value?: string }>;
}
interface HyoTable {
  ColumnList?: Array<{ CellList?: HyoCell[] }>;
}

function cellValue(cell: HyoCell): number | null {
  const text = (cell.PropertyList?.find((p) => p.Name === 'innerHTML')?.Value ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** One 正時 table file → row times (UTC) and numeric columns. */
export function parseHourlyTable(src: string): HourlyTable | null {
  const t = src.match(/'NewTime'\s*:\s*"(\d{4})\\?\/(\d{2})\\?\/(\d{2}) (\d{2}):(\d{2})/);
  if (!t) return null;
  const newTime = Date.UTC(
    Number(t[1]),
    Number(t[2]) - 1,
    Number(t[3]),
    Number(t[4]) - 9,
    Number(t[5]),
  );
  const key = src.indexOf("'HyoAll'");
  const start = src.indexOf('[', key);
  const end = src.lastIndexOf(']') + 1;
  if (key < 0 || start < 0 || end <= start) return null;
  let hyo: HyoTable[];
  try {
    hyo = JSON.parse(src.slice(start, end)) as HyoTable[];
  } catch {
    return null;
  }
  const columns = (hyo[0]?.ColumnList ?? []).map((c) => (c.CellList ?? []).map(cellValue));
  const rows = columns[0]?.length ?? 0;
  if (rows === 0 || columns.some((c) => c.length !== rows)) return null;
  const observedAt = Array.from(
    { length: rows },
    (_, i) => new Date(newTime - (rows - 1 - i) * 3_600_000),
  );
  return { observedAt, columns };
}

export interface TonekakoHour {
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/**
 * 利根川河口堰 hours from the 水位表 and 流量表, joined on time — the two files
 * are fetched separately and can straddle an hourly update. A table whose
 * layout is no longer the 8 known columns contributes nothing, so a shifted
 * column is never stored under the wrong label.
 */
export function tonekakoHours(suiiSrc: string, ryuryoSrc: string): TonekakoHour[] {
  const suii = parseHourlyTable(suiiSrc);
  const ryuryo = parseHourlyTable(ryuryoSrc);
  if (suii?.columns.length !== COLUMNS || ryuryo?.columns.length !== COLUMNS) return [];
  const byTime = new Map<number, TonekakoHour>();
  const hour = (at: Date): TonekakoHour => {
    const existing = byTime.get(at.getTime());
    if (existing) return existing;
    const fresh = { observedAt: at, waterLevelM: null, inflowM3s: null, outflowM3s: null };
    byTime.set(at.getTime(), fresh);
    return fresh;
  };
  suii.observedAt.forEach((at, i) => {
    hour(at).waterLevelM = suii.columns[SUII_UPSTREAM_COL]?.[i] ?? null;
  });
  ryuryo.observedAt.forEach((at, i) => {
    const h = hour(at);
    h.inflowM3s = ryuryo.columns[RYURYO_INFLOW_COL]?.[i] ?? null;
    h.outflowM3s = ryuryo.columns[RYURYO_THROUGH_COL]?.[i] ?? null;
  });
  return [...byTime.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 298,
            '水資源機構 利根川河口堰管理所 利根河口堰 情報提供 — 堰上流水位(Y.P.)・堰流入量 hourly',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function bindWeir(log: (s: string) => void): Promise<bigint | null> {
  // （元） and （再） rank alike so chooseRanked binds the current twin.
  const candidates = await sql<(BindableMaster & { rank: number })[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp,
           CASE
             WHEN name = ${STATION}                THEN 0
             WHEN name LIKE ${`${STATION}（再）%`} THEN 1
             WHEN name LIKE ${`${STATION}（元）%`} THEN 1
             ELSE 2
           END AS rank
    FROM dams
    WHERE pref_code = ANY(${PREF_CODES}::text[])
      AND name LIKE ${`${STATION}%`}
  `;
  const r = chooseRanked(candidates, STATION);
  await recordUniverse(SOURCE_ID, [
    // No prefCode: the weir is on the border and pref_code is sticky once written.
    { externalId: STATION, name: STATION, prefCode: null, resolvedDamId: r?.id ?? null },
  ]);
  if (!r) {
    log(`${SOURCE_ID}: no master match for "${STATION}"`);
    return null;
  }
  await bindExternalId(r.id, SOURCE_ID, STATION);
  return r.id;
}

async function fetchText(file: string): Promise<string | null> {
  const r = await fetch(`${BASE_URL}/${file}?time=${Date.now()}`, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  return r.status === 200 ? r.text() : null;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const damId = await bindWeir(log);

  const [suii, ryuryo] = await Promise.all([fetchText(SUII_FILE), fetchText(RYURYO_FILE)]);
  if (suii === null || ryuryo === null) {
    log(`${SOURCE_ID}: table fetch failed; aborting`);
    return;
  }
  const hours = tonekakoHours(suii, ryuryo);
  log(`${SOURCE_ID}: parsed ${hours.length} hours`);
  if (hours.length === 0) {
    log(`${SOURCE_ID}: table layout not recognised; nothing stored`);
    return;
  }
  if (!damId) return;

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const h of hours) {
    if (h.waterLevelM === null && h.inflowM3s === null && h.outflowM3s === null) continue;
    inputs.push({
      observedAt: h.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: null,
      inflowM3s: h.inflowM3s,
      outflowM3s: h.outflowM3s,
      waterLevelM: h.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${hours.length} matched=1 written=${written}`);
};

export default task;
