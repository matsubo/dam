// apps/worker/src/tasks/ingest_kanagawa.ts
//
// Fifth real-observation source. かながわの水がめ (kanagawa-dam.jp) is a
// JS-rendered SPA but its XHR endpoint is plain JSON, so we skip Playwright
// and hit it directly:
//
//   https://kanagawa-dam.jp/api/summary.php
//
// Payload (excerpt):
//   {
//     "lastUpdate": "2026-09-27",
//     "values": {
//       "sagami_volume": {"0":"34509", ..., "29":"34615", "dt":"2026-09-27 03:00"},
//       "sagami_storage_level": {...},          // 貯水率 %
//       "sagami_water_level": {...},            // 貯水位 EL.m
//       "sagami_in": {...},                     // 流入量 m³/s
//       "sagami_out": {...},                    // 放流量 m³/s
//       ... same shape for shiroyama / miho / miyagase / doushi
//     }
//   }
//
// Each series is a 30-DAY daily window: index 29 is the `lastUpdate` day,
// index 0 is 29 days earlier. Checked against the hourly /api/weekly.php
// table: volume / storage_level / water_level are the day's 24:00 JST reading,
// in / out are the day's hourly mean. lastUpdate rolls over at ~01:00 JST.
// The per-series `dt` is NOT a reading time — it steps back one hour per key
// in response order — so it is ignored; every day is stamped at 24:00 JST.
//
// All 5 dams are NEW — none were covered by tokyo-waterworks / jwa-junpo /
// aitoyo / jwa-chikugo. They're high-profile dams supplying the Kanagawa
// prefecture water system (~9 million people).
//
// The whole window is upserted each run, so a missed poll heals itself. The
// five dams are a catalogue known in advance: when the API cannot be read,
// they are still listed, unreadable.

import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';

const API_URL = process.env.KANAGAWA_DAM_API ?? 'https://kanagawa-dam.jp/api/summary.php';

const SOURCE_ID = 'kanagawa-dam';
const PREF_CODE = '14';

/**
 * The API names its series by key (`sagami_volume`), so the key is the
 * provider's own identifier; the name is the master's.
 */
const DAMS: readonly { key: string; name: string }[] = [
  { key: 'sagami', name: '相模' },
  { key: 'shiroyama', name: '城山' },
  { key: 'miho', name: '三保' },
  { key: 'miyagase', name: '宮ヶ瀬' },
  { key: 'doushi', name: '道志' },
];

/** Day index → value; also carries the meaningless `dt`, never read. */
type RawSeries = Record<string, string>;

export interface ApiResponse {
  lastUpdate: string;
  values: Record<string, RawSeries>;
}

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

function num(s: string | null | undefined): number | null {
  if (s == null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `lastUpdate` 「YYYY-MM-DD」 → that day's 24:00 JST (= 15:00Z the same date). */
export function parseKanagawaLastUpdate(s: string): Date | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 15));
}

/** One dam's 30-day window; a day without any value is left out. */
function windowOf(body: ApiResponse, key: string, newest: Date): Observed[] {
  const vol = body.values[`${key}_volume`];
  const rate = body.values[`${key}_storage_level`];
  const level = body.values[`${key}_water_level`];
  const inflow = body.values[`${key}_in`];
  const outflow = body.values[`${key}_out`];
  const out: Observed[] = [];
  for (let i = 0; i < WINDOW_DAYS; i++) {
    const idx = String(i);
    const volThouM3 = num(vol?.[idx]);
    const ratePct = num(rate?.[idx]);
    const row: Observed = {
      observedAt: new Date(newest.getTime() - (WINDOW_DAYS - 1 - i) * DAY_MS),
      // kanagawa volume is in 千m³ (thousand m³).
      storageVolumeM3: volThouM3 != null ? volThouM3 * 1_000 : null,
      storageRate: ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null,
      waterLevelM: num(level?.[idx]),
      inflowM3s: num(inflow?.[idx]),
      outflowM3s: num(outflow?.[idx]),
    };
    if (
      row.storageVolumeM3 == null &&
      row.storageRate == null &&
      row.waterLevelM == null &&
      row.inflowM3s == null &&
      row.outflowM3s == null
    ) {
      continue;
    }
    out.push(row);
  }
  return out;
}

/** Every dam of the catalogue, read from the summary response. */
export function kanagawaEntries(body: ApiResponse): Entry[] {
  const newest = parseKanagawaLastUpdate(body.lastUpdate);
  return DAMS.map((d) => {
    let reading: Reading;
    if (!newest) {
      reading = { state: 'unreadable', why: `lastUpdate "${body.lastUpdate}"` };
    } else {
      const observations = windowOf(body, d.key, newest);
      reading =
        observations.length > 0
          ? { state: 'values', observations }
          : { state: 'unreadable', why: `no ${d.key}_* value in the window` };
    }
    return { key: d.key, name: d.name, pref: PREF_CODE, reading };
  });
}

/** The catalogue when the API could not be read. */
export function kanagawaUnreadable(why: string): Entry[] {
  return DAMS.map(
    (d): Entry => ({
      key: d.key,
      name: d.name,
      pref: PREF_CODE,
      reading: { state: 'unreadable', why },
    }),
  );
}

async function fetchSummary(): Promise<ApiResponse> {
  const r = await fetch(API_URL, {
    headers: {
      accept: 'application/json',
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as ApiResponse;
}

export default ingestTask(SOURCE_ID, async (log) => {
  let body: ApiResponse;
  try {
    body = await fetchSummary();
  } catch (err) {
    const why = `summary.php: ${err instanceof Error ? err.message : String(err)}`;
    log(`${SOURCE_ID}: ${why}`);
    return { entries: kanagawaUnreadable(why) };
  }
  log(`${SOURCE_ID}: lastUpdate ${body.lastUpdate}`);
  return { entries: kanagawaEntries(body) };
});
