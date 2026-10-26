// apps/worker/src/tasks/ingest_mie_kigyo.ts
//
// 三重県企業庁「県営水道用水供給事業及び工業用水道事業の水源状況」 — the 7
// reservoirs behind the 企業庁's water-supply and industrial-water systems,
// weekly.
//
// Source: https://www.pref.mie.lg.jp/D1KIGYO/12674013222.htm
// Static UTF-8 HTML. A 「令和8年9月24日（木）現在」 line above one table:
//   <th>ダム名</th> | 有効貯水量（千ｍ３） | 現在貯水量（千ｍ３） | 貯水率（％） | 対象事業
// The page publishes no time of day, so the table is stamped 00:00 JST of the
// 現在 date. It says it is updated every Monday (Tuesday after a holiday);
// the 9/24 table went up on a Thursday, so it is polled daily.
//
// Rate: each row prints its own 有効貯水量 denominator, so the rate is kept
// only where that is the master's active capacity (observationValues). On
// the 2026-09-24 table 伊坂 3,254 / 87.5 % = 3,719 千m³ against a printed
// 3,716 and a master 3,715; 菰野調整池 1,326 / 82.8 % = 1,601 against 1,600
// and 1,600. 山村 prints 1,964 against a master 2,183 (工業用水 only, no flood
// pool to explain the gap), so its 89.4 % is on a different basis: the volume
// is stored and the rate left to the trigger's volume / active capacity.
// Where the rate is kept it is the site's own static denominator, so the
// source is not marked trusted (0048's okinawa-eb reasoning).
//
// 岩屋 (岐阜, jwa-kiso-rt / kasenbosai / gifu-kasen), 中里 (jwa-kiso-rt),
// 君ヶ野 and 蓮 (kasenbosai) are published here too but only recorded in the
// universe: they have 10-minute feeds, and at priority 291 this weekly table
// would outrank several of them. 岩屋's printed 有効 is also a seasonal
// interpolation (footnote), not a capacity. 伊坂 / 山村 / 菰野調整池 have no
// other source.
//
// Cron daily 07:17 UTC (16:17 JST), after a weekday-daytime update.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const PAGE_URL = process.env.MIE_KIGYO_URL ?? 'https://www.pref.mie.lg.jp/D1KIGYO/12674013222.htm';

const SOURCE_ID = 'mie-kigyo';
const PREF_CODE = '24';
/** 岩屋ダム is on the 飛騨川 in 岐阜; every other dam is in 三重. */
const PREF_BY_NAME: Readonly<Record<string, string>> = { 岩屋ダム: '21' };
/** Covered by 10-minute feeds; see the header. */
const UNIVERSE_ONLY: Readonly<Record<string, true>> = {
  岩屋ダム: true,
  中里ダム: true,
  君ヶ野ダム: true,
  蓮ダム: true,
};
/** Printed 有効 vs master active capacity: 伊坂 is off by 0.03 %, 山村 by 10 %. */
const CAPACITY_TOLERANCE = 0.01;

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** ダム名 as published ("伊坂ダム"); also the stamp and universe key. */
  name: string;
  /** The row's printed 有効貯水量, the denominator of its 貯水率. */
  capacityM3: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

/** Tag-free, NFKC-folded (full-width digits → ASCII), whitespace-free text. */
function flat(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .normalize('NFKC')
    .replace(/\s+/g, '');
}

function num(cell: string | undefined): number | null {
  const t = flat(cell ?? '').replace(/,/g, '');
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** 「令和8年9月24日（木）現在」 → 00:00 JST of that day, in UTC. */
function parseAsOf(html: string): Date | null {
  const m = flat(html).match(/令和(元|\d{1,2})年(\d{1,2})月(\d{1,2})日(?:\([^)]*\))?現在/);
  if (!m) return null;
  const year = 2018 + (m[1] === '元' ? 1 : Number(m[1]));
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), -9));
}

export function parseMieKigyoSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const name = flat(body.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '');
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (!name || cells.length !== 4) continue;
    const capacity = num(cells[0]);
    const volume = num(cells[1]);
    const rate = num(cells[2]);
    rows.push({
      name,
      capacityM3: capacity === null ? null : capacity * 1000,
      storageVolumeM3: volume === null ? null : volume * 1000,
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseAsOf(html), rows };
}

/**
 * What to store for a row: the volume always, the rate only when the row's
 * printed 有効貯水量 is the master's active capacity (else it is a percentage
 * of something the site cannot show next to it). Null when nothing is left.
 */
export function observationValues(
  row: ParsedRow,
  activeCapacityM3: number | null,
): { storageVolumeM3: number | null; storageRate: number | null } | null {
  const sameBasis =
    row.capacityM3 !== null &&
    activeCapacityM3 !== null &&
    activeCapacityM3 > 0 &&
    Math.abs(row.capacityM3 - activeCapacityM3) / activeCapacityM3 <= CAPACITY_TOLERANCE;
  const storageRate = sameBasis ? row.storageRate : null;
  if (row.storageVolumeM3 === null && storageRate === null) return null;
  return { storageVolumeM3: row.storageVolumeM3, storageRate };
}

/** A row's reading once its master's active capacity is known. */
export function mieReading(
  observedAt: Date,
  row: ParsedRow,
  activeCapacityM3: number | null,
): Reading {
  const values = observationValues(row, activeCapacityM3);
  if (!values)
    return { state: 'unreadable', why: 'no 現在貯水量, and no 貯水率 on the master basis' };
  return { state: 'values', observations: [{ observedAt, ...values }] };
}

/**
 * Every published dam, bound by its same-stem master in its prefecture (exact
 * rungs only); the four with 10-minute feeds are recorded, never written.
 */
export function mieEntries(observedAt: Date, rows: ParsedRow[]): Entry[] {
  return rows.map(
    (row): Entry => ({
      key: row.name,
      name: row.name,
      pref: PREF_BY_NAME[row.name] ?? PREF_CODE,
      bind: { exact: true },
      ...(UNIVERSE_ONLY[row.name] ? { dontWrite: 'a 10-minute feed covers it' } : {}),
      reading: (dam) => mieReading(observedAt, row, dam?.activeCapacityM3 ?? null),
    }),
  );
}

export default ingestTask(SOURCE_ID, async (log) => {
  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`${SOURCE_ID}: HTTP ${r.status} from ${PAGE_URL}`);

  const { observedAt, rows } = parseMieKigyoSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「令和…現在」 line on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} dams as of ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: date found but no dam rows — layout change?`);
  }
  return { entries: mieEntries(observedAt, rows) };
});
