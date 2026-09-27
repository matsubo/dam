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
// 貯水容量 is counted from the reservoir bed. 貯水容量 + 空容量 equals the
// 総貯水容量 for 初瀬 (2,015 + 2,375 = 4,390), 天理 (1,037 + 1,463 = 2,500) and
// 岩井川 (179 + 631 = 810), so 堆砂容量 (総 − 有効: 650 / 250 / 120 千m³ on the
// prefecture's spec pages) is inside it. The 0036 trigger divides the stored
// volume by 有効貯水容量, so we store 貯水容量 − 堆砂容量 — the water above
// 最低水位 — and only for a dam whose printed sum matches the master 総貯水容量.
// 白川 (338 + 1,222 = 1,560) matches since 0070 set its total to the
// prefecture's 1,560; a master:refresh:damnet run writes ダム便覧's 1,360 back
// and its volume is dropped again. 大門 (146 + 3 = 149: 空容量 runs to
// 常時満水位, not サーチャージ) cannot be tied to the master, so its volume is
// not stored.
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

export interface MasterCapacity {
  totalCapacityM3: number | null;
  activeCapacityM3: number | null;
}

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
 * Water above 最低水位 (m³), comparable with 有効貯水容量: 貯水容量 less
 * 堆砂容量 (総 − 有効). Null unless 貯水容量 + 空容量 equals the master
 * 総貯水容量, which is what shows the printed volume counts from the bed of
 * that same capacity table.
 */
export function usableVolumeM3(
  row: Pick<ParsedRow, 'storedVolumeM3' | 'emptyVolumeM3'>,
  cap: MasterCapacity,
): number | null {
  const { storedVolumeM3: stored, emptyVolumeM3: empty } = row;
  const { totalCapacityM3: total, activeCapacityM3: active } = cap;
  if (stored === null || empty === null || total === null || active === null) return null;
  if (Math.abs(stored + empty - total) > PRINT_ROUNDING_M3) return null;
  return Math.max(0, stored - (total - active));
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
  capacity: MasterCapacity;
}

async function matchMaster(rows: ParsedRow[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<(BindableMaster & MasterCapacity)[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp,
           total_capacity_m3::float8 AS "totalCapacityM3",
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
    out.push({ naraName: r.naraName, damId, capacity: master });
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
    const volume = usableVolumeM3(p, match.capacity);
    if (volume === null && p.storedVolumeM3 !== null && p.emptyVolumeM3 !== null) {
      // A printed volume was dropped: the table no longer ties to the master
      // (e.g. a ダム便覧 refresh changed 総/有効), or a capacity is missing.
      const { totalCapacityM3: total, activeCapacityM3: active } = match.capacity;
      log(
        `${SOURCE_ID}: volume not stored for "${p.naraName}": ` +
          `貯水容量+空容量=${p.storedVolumeM3 + p.emptyVolumeM3} m³, ` +
          `master total=${total ?? 'null'} active=${active ?? 'null'}`,
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
