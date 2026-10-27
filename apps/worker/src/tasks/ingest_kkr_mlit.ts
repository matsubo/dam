// apps/worker/src/tasks/ingest_kkr_mlit.ts
//
// 国土交通省 近畿地方整備局 — 12 国管理ダム 貯水率 (JSON feed, 日次).
//
//   Dams (key → name → prefecture):
//     managawa  → 真名川ダム  (Fukui  18)
//     kuzuryu   → 九頭竜ダム  (Fukui  18)
//     amagase   → 天ヶ瀬ダム  (Kyoto  26)
//     hiyoshi   → 日吉ダム    (Kyoto  26)
//     muro      → 室生ダム    (Nara   29)
//     syourenji → 青蓮寺ダム  (Mie    24)
//     takayama  → 高山ダム    (Kyoto  26)
//     nunome    → 布目ダム    (Nara   29)
//     hinati    → 比奈知ダム  (Mie    24)
//     hitokura  → 一庫ダム    (Hyogo  28)
//     otaki     → 大滝ダム    (Nara   29)
//     sarutani  → 猿谷ダム    (Nara   29)
//
// Source:
//   https://www.kkr.mlit.go.jp/river/json/dam.json
// Format: UTF-8 JSON. "datetime" field is JST "YYYY-MM-DD HH:MM:SS".
//   Each dam entry: { chosuiritsu: { today: "XX.X", diff: ["X.X", "↑"] } }
// Cadence: weekday daily (土日祝日除く). We poll daily at 03:00 UTC = 12:00 JST.
//   UPSERT on (dam_id, observed_at, source_id) makes repeated polls idempotent.
// Priority: 302 — MLIT national management, daily cadence.
//   Slightly below hourly MLIT sources (304) but above JWA daily (296).
//
// The feed's `dam` keys are the universe, plus every configured dam the day's
// JSON leaves out (unreadable), so the universe stays complete when one
// dam's entry is missing. The feed prints no "no value" mark of its own: a
// blank or implausible 貯水率 is unreadable.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.KKR_MLIT_URL ?? 'https://www.kkr.mlit.go.jp/river/json/dam.json';

const SOURCE_ID = 'kkr-mlit-dam';

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

/**
 * The feed publishes 貯水率 as a percent string ("89.3", and "100.0" for a full
 * reservoir). `observations.storage_rate` is a 0..1 fraction in NUMERIC(6,4),
 * so writing the percent straight through was wrong twice over (issue #46):
 *
 *   - every stored rate was 100x too large — 89.3 means 8,930 %. Same bug as
 *     okinawa-eb in #38 §2-1, which migration 0046 had to undo.
 *   - NUMERIC(6,4) tops out at 99.9999, so the first dam to reach 100.0 %
 *     overflowed and failed the whole task. 一庫ダム published exactly 100.0 on
 *     2026-09-14, and every 近畿 dam has been stale since.
 *
 * A reading outside 0..MAX_PLAUSIBLE_PCT is unreadable rather than clipped: a
 * clipped value is indistinguishable from a real one downstream, and 0 % would
 * recreate the phantom-zero problem 0038/0039 had to dig out.
 */
export function toFraction(pct: number | null): number | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct <= 0 || pct > MAX_PLAUSIBLE_PCT) return null;
  return pct / 100;
}

// JSON key → canonical Japanese dam name and the prefecture of its master.
const KEYS: Record<string, { name: string; pref: string }> = {
  managawa: { name: '真名川ダム', pref: '18' },
  kuzuryu: { name: '九頭竜ダム', pref: '18' },
  amagase: { name: '天ヶ瀬ダム', pref: '26' },
  hiyoshi: { name: '日吉ダム', pref: '26' },
  muro: { name: '室生ダム', pref: '29' },
  syourenji: { name: '青蓮寺ダム', pref: '24' },
  takayama: { name: '高山ダム', pref: '26' },
  nunome: { name: '布目ダム', pref: '29' },
  hinati: { name: '比奈知ダム', pref: '24' },
  hitokura: { name: '一庫ダム', pref: '28' },
  otaki: { name: '大滝ダム', pref: '29' },
  sarutani: { name: '猿谷ダム', pref: '29' },
};
/** Where a dam the feed adds would be: the five prefectures it covers. */
const PREF_CODES = [...new Set(Object.values(KEYS).map((k) => k.pref))];

// --- parsing ----------------------------------------------------------------

/** "YYYY-MM-DD HH:MM:SS" JST → UTC Date */
export function parseKkrDatetime(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const yr = Number(m[1]);
  const mo = Number(m[2]);
  const dy = Number(m[3]);
  const hr = Number(m[4]);
  const mi = Number(m[5]);
  const sc = Number(m[6]);
  const d = new Date(Date.UTC(yr, mo - 1, dy, hr - 9, mi, sc, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

interface KkrJson {
  datetime?: string;
  dam?: Record<string, { chosuiritsu?: { today?: string } } | undefined>;
}

function damReading(
  entry: { chosuiritsu?: { today?: string } } | undefined,
  observedAt: Date | null,
  datetime: string | undefined,
): Reading {
  if (!entry) return { state: 'unreadable', why: "not in today's feed" };
  if (!observedAt) return { state: 'unreadable', why: `datetime "${datetime}"` };
  const rateStr = entry.chosuiritsu?.today?.trim() ?? '';
  const storageRate = toFraction(rateStr === '' ? null : Number(rateStr));
  if (storageRate === null) return { state: 'unreadable', why: `貯水率 "${rateStr}"` };
  return { state: 'values', observations: [{ observedAt, storageRate }] };
}

/** Every dam key in the JSON, then every configured dam it leaves out. */
export function kkrEntries(raw: unknown): Entry[] {
  const data = raw as KkrJson;
  const observedAt = parseKkrDatetime(data.datetime ?? '');
  const dams = data.dam ?? {};
  const keys = [...new Set([...Object.keys(dams), ...Object.keys(KEYS)])];
  return keys.map((key) => {
    const cfg = KEYS[key];
    return {
      key,
      name: cfg?.name ?? key,
      pref: cfg?.pref ?? PREF_CODES,
      reading: damReading(dams[key], observedAt, data.datetime),
    };
  });
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async ({ log, upstream }) => {
  const entries = kkrEntries((await upstream.fetch(DATA_URL)).json<unknown>());
  log(`${SOURCE_ID}: ${entries.length} dams`);
  return { entries };
});
