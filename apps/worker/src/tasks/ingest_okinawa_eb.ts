// apps/worker/src/tasks/ingest_okinawa_eb.ts
//
// 沖縄県企業局 — 2 個別ダム 日次.
//
//   倉敷ダム (沖縄 47, 県管理) / 山城ダム (沖縄 47, 企業局管理)
//
// Source:
//   https://www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv
// Format: UTF-8 CSV, 5 rows x 5 columns. Updated daily at midnight JST.
//   Row 0: date (MM月DD日), national_vol, kurasiki_vol, yamashiro_vol, total_vol
//   Row 1: (same date), national_max, kurasiki_max, yamashiro_max, total_max
//   Row 2: (same date), national_rate, kurasiki_rate, yamashiro_rate, total_rate
//   Row 3: (same date), national_avg, kurasiki_avg, yamashiro_avg, total_avg
//   Row 4: (same date), national_diff, kurasiki_diff, yamashiro_diff, total_diff
//   All volume values are in 千m³ (1000 m³); row 2 rates are percentages.
// Coverage:
//   倉敷ダム (col 2): 県管理 — 5,900千m³ total capacity
//   山城ダム (col 3): 企業局管理 — 1,190千m³ total capacity
//   国管理ダム (col 1): aggregate for 9 national dams; NOT stored here
//     (those 9 dams are covered by kasenbosai_v2 via kawabou)
// Priority: 302 (pref/bureau-managed water supply, daily).
// Cron: daily at 03:00 UTC = 12:00 JST.

import { cell, cellState, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Reading } from '../ingest/types.ts';

const CSV_URL =
  process.env.OKINAWA_EB_CSV_URL ?? 'https://www.eb.pref.okinawa.jp/js/chart/dam-youryou.csv';

const PREF_CODE = '47';
const SOURCE_ID = 'okinawa-eb';

// The CSV has no station ids, so the published name is the stable identity.
const DAMS: ReadonlyArray<{ csvName: string; colIdx: number }> = [
  { csvName: '倉敷ダム', colIdx: 2 },
  { csvName: '山城ダム', colIdx: 3 },
];

// --- parsing ----------------------------------------------------------------

/**
 * Parse "MM月DD日" with no year, returning a Date at midnight JST.
 * Year is inferred: if the parsed month/day is more than 1 day ahead of
 * `now` (in JST), decrement the year by one (i.e. the data is from last year).
 */
export function parseOkinawaDate(dateStr: string, now: Date = new Date()): Date | null {
  const m = dateStr.match(/^(\d{1,2})月(\d{1,2})日$/);
  if (!m) return null;
  const mo = Number(m[1]);
  const dy = Number(m[2]);
  if (Number.isNaN(mo) || Number.isNaN(dy)) return null;

  // Current JST date
  const nowJst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let year = nowJst.getUTCFullYear();

  // Try this year first; if >1 day in the future, fall back to last year
  let candidate = new Date(Date.UTC(year, mo - 1, dy, -9, 0, 0, 0));
  if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
    candidate = new Date(Date.UTC(year, mo - 1, dy, -9, 0, 0, 0));
  }
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function num(raw: string | undefined): number | null {
  const t = raw?.trim();
  return t ? numberIn(cell(Number(t), false)) : null;
}

/**
 * Both dam columns of the 5-row dam-youryou.csv, whether or not they carry a
 * value today; a column we cannot read (no date, too few rows) is unreadable.
 */
export function okinawaEbEntries(csv: string, now: Date = new Date()): Entry[] {
  const lines = csv
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Row 0: date,national_vol,kurasiki_vol,yamashiro_vol,total_vol
  const volCols = lines[0]?.split(',') ?? [];
  // Row 2: date,national_rate,kurasiki_rate,yamashiro_rate,total_rate
  const rateCols = lines[2]?.split(',') ?? [];
  const observedAt = parseOkinawaDate(volCols[0]?.trim() ?? '', now);

  return DAMS.map((dam) => {
    const reading = ((): Reading => {
      if (lines.length < 3) return { state: 'unreadable', why: `${lines.length} CSV rows` };
      if (!observedAt) return { state: 'unreadable', why: `date "${volCols[0] ?? ''}"` };
      const volThousandsM3 = num(volCols[dam.colIdx]);
      const rate = num(rateCols[dam.colIdx]);
      if (cellState([volThousandsM3, rate]) !== 'values') {
        return { state: 'unreadable', why: 'no number in the column' };
      }
      return {
        state: 'values',
        observations: [
          {
            observedAt,
            storageVolumeM3: volThousandsM3 !== null ? volThousandsM3 * 1000 : null,
            // CSV row 2 is a percentage (e.g. "95.1"); observations.storage_rate is
            // a 0–1 fraction. Issue #38 §2-1: 山城ダム was published as 95.1 instead
            // of 0.951. Same class as 0030_fix_jwa_chiba_storage_rate.sql.
            storageRate: rate !== null ? Math.max(0, Math.min(1, rate / 100)) : null,
          },
        ],
      };
    })();
    return { key: dam.csvName, name: dam.csvName, pref: PREF_CODE, reading };
  });
}

// --- task -------------------------------------------------------------------

export default ingestTask(SOURCE_ID, async (log) => {
  const ua =
    process.env.HTTP_USER_AGENT ??
    'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

  let csv: string;
  try {
    const r = await fetch(CSV_URL, {
      headers: { 'user-agent': ua },
      signal: AbortSignal.timeout(20_000),
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    csv = await r.text();
  } catch (err) {
    // Both columns are known in advance: record them unreadable.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return {
      entries: okinawaEbEntries('').map(
        (e): Entry => ({ ...e, reading: { state: 'unreadable', why } }),
      ),
    };
  }
  return { entries: okinawaEbEntries(csv) };
});
