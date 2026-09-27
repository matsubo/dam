// apps/worker/src/tasks/ingest_nara_kasen.ts
//
// 奈良県河川情報システム ダム現況表 (PC) — 5 県管理ダム, 10分更新.
//
//   岩井川/天理/白川/初瀬/大門
//
// Source: the 防災Web dam table (dk=4), one GET, no session needed:
//   https://www.kasen.pref.nara.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus?…&dk=4…
// Format: Shift_JIS HTML, one <tr> of 10 cells per dam:
//   管理者名 | 河川名 | 局名 | 所在地 | 最新観測時刻 "YYYY MM/DD HH:MM" (JST) |
//   貯水位[EL.m] | 貯水容量[10³m³] | 空容量[10³m³] | 全流入量[m³/s] | 放流量[m³/s]
// Values carry a trend arrow (&rarr;/&uarr;/&darr;) and &nbsp; padding; the
// legend marks ***=欠測, ---=無効, ###=データ異常, blank=未入力. No 貯水率.
//
// 空容量 is the room left up to a fixed top, so 貯水容量 + 空容量 is constant
// (±1 for rounding) at every level. Checked on the live table and on
// historical ones (nw=0&tm=…, 1st/15th of each month since 2024-01 and every
// day of June–October 2024–2026, EL from near 最低水位 to over 常時満水位)
// against the prefecture's spec pages (pref.nara.lg.jp/n138/9773, 9769, 9772,
// 9770) and each station's ダムグラフ (servletBousaiGraph?sy=gra_dam):
//
//   初瀬   4,390  = 総貯水容量; 空容量 keeps falling above 常時満水位 221.60
//                  (EL 222.95 → 2,193 < 洪水調節容量 2,390)
//   天理   2,500  = 総; at 常時満水位 255.00, 空容量 1,298 ≈ 洪水調節容量 1,300
//   岩井川   810  = 総; EL 247.75 (常時満水位 247.00) → 401 < 洪水調節容量 430
//   白川   1,560  = 総 on the spec page (有効 1,360 + 堆砂 200); at 117.38
//                  (常時満水位 117.30) 空容量 488 ≈ 洪水調節容量 500
//   大門     149  ≠ 総 177: 空容量 reaches 0 at 常時満水位 262.70 and stays 0
//                  above it (EL 262.87 → 153 / 0)
//
// So for the first four 空容量 counts down from サーチャージ水位, the top of
// 有効貯水容量, and 有効 − 空容量 is the water above 最低水位 — the volume the
// 0036 trigger divides by 有効貯水容量. It needs no 総貯水容量 from the
// master, which matters for 白川: ダム便覧 No.1572 lists 総 = 有効 = 1,360
// 千m³ without the 堆砂, and master:refresh:damnet rewrites it monthly. 有効
// is 3,740 / 2,250 / 690 / 1,360 千m³ in both the master and the spec pages.
//
// 大門's 空容量 runs to 常時満水位 instead, so 有効 − 空容量 overstates it by the
// 30 千m³ flood pool (MLIT ダム諸量 form01/383: 総 177 = 堆砂 29 + 利水 118 +
// 洪水 30) and reads full on every flood. 貯水容量 − 堆砂 does not tie either:
// the table's 149 at 常時満水位 is 2 千m³ over 堆砂 + 利水 = 147, so its zero is
// not the master's. 大門's volume stays null.
// Priority 308.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const DATA_URL =
  process.env.NARA_KASEN_DAM_URL ??
  'https://www.kasen.pref.nara.jp/river_pub/servlet/bousaiweb.servletBousaiTableStatus?tvm=0&tsw=0&sv=3&dk=4&mp=0&no=0&fn=0&cn=0&spn=0&pg=1';

const PREF_CODE = '29';
const SOURCE_ID = 'nara-kasen';

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  naraName: string;
  observedAt: Date;
  waterLevelM: number | null;
  /** 貯水容量 as printed, in m³: counted from the reservoir bed. */
  storedVolumeM3: number | null;
  /** 空容量 as printed, in m³. */
  emptyVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

/**
 * 総貯水容量 (m³) the table's 空容量 counts down from, per station: the
 * prefecture spec page's figure, where 貯水容量 + 空容量 was checked to add
 * up at every level. Stations absent here (大門) are not measured to サーチャージ.
 */
const SURCHARGE_TOTAL_M3: Readonly<Record<string, number>> = {
  初瀬ダム: 4_390_000,
  天理ダム: 2_500_000,
  岩井川ダム: 810_000,
  白川ダム: 1_560_000,
};

// --- parsing ----------------------------------------------------------------

/** Decode the entities/arrows/padding the table wraps value cells in. */
function cleanCell(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&(rarr|uarr|darr);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A cleaned value cell as a number; the ***, ---, ### markers and blank → null. */
function parseNum(s: string): number | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  return Number(s);
}

/** "YYYY MM/DD HH:MM" (JST) → UTC. */
function parseStamp(s: string): Date | null {
  const m = s.match(/^(\d{4}) (\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5])),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

function thousandM3(s: string): number | null {
  const n = parseNum(s);
  return n === null ? null : n * 1000;
}

export function parseNaraTable(html: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) =>
      cleanCell(c[1] ?? ''),
    );
    if (cells.length !== 10) continue;
    // Header rows fail here: their 観測時刻 cell is a label.
    const observedAt = parseStamp(cells[4] ?? '');
    const naraName = cells[2] ?? '';
    if (!observedAt || !naraName) continue;

    const row: ParsedRow = {
      naraName,
      observedAt,
      waterLevelM: parseNum(cells[5] ?? ''),
      storedVolumeM3: thousandM3(cells[6] ?? ''),
      emptyVolumeM3: thousandM3(cells[7] ?? ''),
      inflowM3s: parseNum(cells[8] ?? ''),
      outflowM3s: parseNum(cells[9] ?? ''),
    };
    if (
      row.waterLevelM === null &&
      row.storedVolumeM3 === null &&
      row.inflowM3s === null &&
      row.outflowM3s === null
    ) {
      continue;
    }
    rows.push(row);
  }
  return rows;
}

// Each printed 10³ m³ figure is rounded to the unit, so their sum can be off
// by up to 1,000 m³.
const PRINT_ROUNDING_M3 = 1_000;

/**
 * Water above 最低水位 (m³), comparable with 有効貯水容量: 有効 less 空容量.
 * Null for a station whose 空容量 is not counted from サーチャージ, and when
 * 貯水容量 + 空容量 no longer adds up to that station's 総貯水容量.
 */
export function usableVolumeM3(
  row: Pick<ParsedRow, 'naraName' | 'storedVolumeM3' | 'emptyVolumeM3'>,
  activeCapacityM3: number | null,
): number | null {
  const { naraName, storedVolumeM3: stored, emptyVolumeM3: empty } = row;
  const top = SURCHARGE_TOTAL_M3[naraName];
  if (top === undefined || stored === null || empty === null || activeCapacityM3 === null) {
    return null;
  }
  if (Math.abs(stored + empty - top) > PRINT_ROUNDING_M3) return null;
  return Math.max(0, activeCapacityM3 - empty);
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '奈良県河川情報システム ダム現況表 — 5 ダム (防災Web Shift_JIS, 10分更新)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/貯水池$/, '')
    .trim();
}

/** Best master dam for a feed stem; the exact published name ranks first. */
export function chooseMaster(
  stem: string,
  masters: BindableMaster[],
  naraName: string,
): bigint | null {
  // A row already stamped with this station keeps it; names alone cannot
  // separate same-name dams (#57).
  const stamped = stampedMaster(masters, naraName);
  if (stamped) return stamped.id;
  let best: { m: BindableMaster; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === naraName) rank = 0;
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
  naraName: string;
  damId: bigint;
  activeCapacityM3: number | null;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<(BindableMaster & { activeCapacityM3: number | null })[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp,
           active_capacity_m3::float8 AS "activeCapacityM3"
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing. The
  // table's station number is not used, so the published name keyed by
  // prefecture stays the stable identity.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const stem = normalizeName(r.naraName);
    if (!stem) continue;

    const damId = chooseMaster(stem, masters, r.naraName);
    universe.push({
      externalId: r.naraName,
      name: r.naraName,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
    });
    const master = masters.find((m) => m.id === damId);
    if (!damId || !master) {
      log(`${SOURCE_ID}: no master match for "${r.naraName}"`);
      continue;
    }
    out.push({ naraName: r.naraName, damId, activeCapacityM3: master.activeCapacityM3 });
    await bindExternalId(damId, SOURCE_ID, r.naraName);
  }

  await recordUniverse(SOURCE_ID, universe);
  return out;
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

  const raw = await r.arrayBuffer();
  const html = new TextDecoder('shift_jis').decode(raw);
  const rows = parseNaraTable(html);
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows`);

  const matches = await matchMaster(rows, log);
  const matchByName = new Map(matches.map((m) => [m.naraName, m]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const match = matchByName.get(p.naraName);
    if (!match) continue;
    const volume = usableVolumeM3(p, match.activeCapacityM3);
    const top = SURCHARGE_TOTAL_M3[p.naraName];
    if (
      volume === null &&
      top !== undefined &&
      p.storedVolumeM3 !== null &&
      p.emptyVolumeM3 !== null
    ) {
      // A printed volume was dropped: the table stopped adding up to the
      // station's 総貯水容量, or the master lost 有効貯水容量.
      log(
        `${SOURCE_ID}: volume not stored for "${p.naraName}": ` +
          `貯水容量+空容量=${p.storedVolumeM3 + p.emptyVolumeM3} m³ (expected ${top}), ` +
          `master active=${match.activeCapacityM3 ?? 'null'}`,
      );
    }
    inputs.push({
      observedAt: p.observedAt,
      damId: match.damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: volume,
      storageRate: null,
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
