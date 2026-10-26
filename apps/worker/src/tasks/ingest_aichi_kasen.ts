// apps/worker/src/tasks/ingest_aichi_kasen.ts
//
// 愛知県 川の防災情報 ダム表 — 2 ダム, 10分更新.
//
//   2 dams: 雨山/木瀬
//
// Source:
//   https://www.kasen-aichi.jp/DamHis_10_0_1.html
// Format: UTF-8 HTML. Reference datetime in <span id="timestamp">YYYY年MM月DD日 HH時MM分.
//   Data rows: <tr class="even|odd"><th>MM/DD HH:MM</th> + 8 getData spans (2 dams × 4 fields).
//   "**" = 欠測, "--" = 未収集: the page's own marks; a dam with nothing
//   but those in the whole window is provider-marked empty. Storage in 千m³.
// Priority 308.

import { type Cell, cell, cellState, MARKED, numberIn } from '../ingest/cells.ts';
import { ingestTask } from '../ingest/run.ts';
import type { Entry, Observed, Reading } from '../ingest/types.ts';

const DATA_URL = process.env.AICHI_KASEN_DAM_URL ?? 'https://www.kasen-aichi.jp/DamHis_10_0_1.html';

const PREF_CODE = '23';
const SOURCE_ID = 'aichi-kasen';

// Ordered to match column positions in the HTML table (left → right).
const DAM_NAMES = ['雨山ダム', '木瀬ダム'] as const;

// --- parsing ----------------------------------------------------------------

/** Extract the reference year from <span id="timestamp">YYYY年... */
export function parseAichiRefYear(html: string): number | null {
  const m = html.match(/<span id="timestamp">(\d{4})年/);
  return m ? Number(m[1]) : null;
}

/**
 * Build a UTC Date from a row's "MM/DD" + "HH:MM" (JST).
 * Uses refDt to detect Dec→Jan year rollovers: if the constructed date
 * would be more than 1 hour in the future relative to refDt, subtract a year.
 */
export function parseAichiRowTimestamp(
  mmdd: string,
  hhmm: string,
  refYear: number,
  refDt: Date,
): Date | null {
  const [mm, dd] = mmdd.split('/');
  const [hh, mi] = hhmm.split(':');
  if (!mm || !dd || !hh || !mi) return null;
  const month = Number(mm);
  const day = Number(dd);
  const jstHour = Number(hh);
  const jstMin = Number(mi);
  if (
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(jstHour) ||
    !Number.isFinite(jstMin)
  )
    return null;

  let year = refYear;
  let d = new Date(Date.UTC(year, month - 1, day, jstHour - 9, jstMin, 0));
  if (Number.isNaN(d.getTime())) return null;

  if (d.getTime() > refDt.getTime() + 3_600_000) {
    year -= 1;
    d = new Date(Date.UTC(year, month - 1, day, jstHour - 9, jstMin, 0));
  }

  return Number.isNaN(d.getTime()) ? null : d;
}

/** "**" = 欠測, "--" = 未収集: the page's own marks. */
function spanCell(s: string): Cell {
  const t = s.trim();
  if (t === '**' || t === '--') return MARKED;
  return cell(t === '' ? null : Number(t), false);
}

/** One dam's four cells (水位, 貯水量 千m³, 流入量, 放流量) at one row's time. */
interface DamRow {
  observedAt: Date;
  cells: [Cell, Cell, Cell, Cell];
}

/** Each dam's rows, in DAM_NAMES order; null when the page carries no reference time. */
export function parseAichiPage(html: string): DamRow[][] | null {
  const refYear = parseAichiRefYear(html);
  if (!refYear) return null;

  const refDtMatch = html.match(
    /<span id="timestamp">(\d{4})年(\d{2})月(\d{2})日 (\d{2})時(\d{2})分/,
  );
  if (!refDtMatch) return null;
  const refDt = new Date(
    Date.UTC(
      Number(refDtMatch[1]),
      Number(refDtMatch[2]) - 1,
      Number(refDtMatch[3]),
      Number(refDtMatch[4]) - 9,
      Number(refDtMatch[5]),
      0,
    ),
  );
  if (Number.isNaN(refDt.getTime())) return null;

  const dams: DamRow[][] = DAM_NAMES.map(() => []);
  const rowRe = /<tr class="(?:even|odd)">\s*<th>(\d{2}\/\d{2} \d{2}:\d{2})<\/th>([\s\S]*?)<\/tr>/g;
  // Match first span in each getData cell (ignores .label spans for 欠測/未収集).
  const cellRe = /<td class="getData">\s*<span(?:\s[^>]*)?>([^<]*)<\/span>/g;

  for (const rowMatch of html.matchAll(rowRe)) {
    const tsStr = rowMatch[1]?.trim() ?? '';
    const spaceIdx = tsStr.indexOf(' ');
    if (spaceIdx < 0) continue;
    const mmdd = tsStr.slice(0, spaceIdx);
    const hhmm = tsStr.slice(spaceIdx + 1);

    const observedAt = parseAichiRowTimestamp(mmdd, hhmm, refYear, refDt);
    if (!observedAt) continue;

    const vals = [...(rowMatch[2] ?? '').matchAll(cellRe)].map((m) => spanCell(m[1] ?? ''));
    if (vals.length < 8) continue;

    dams.forEach((rows, i) => {
      const base = i * 4;
      rows.push({
        observedAt,
        cells: [
          vals[base] ?? null,
          vals[base + 1] ?? null,
          vals[base + 2] ?? null,
          vals[base + 3] ?? null,
        ],
      });
    });
  }

  return dams;
}

/** A dam's reading over the page's window: every row that carries a value. */
function damReading(rows: DamRow[]): Reading {
  const state = cellState(rows.flatMap((r) => r.cells));
  if (state === 'empty') return { state, mark: '"**" (欠測) / "--" (未収集) in every row' };
  if (state === 'unreadable') return { state, why: 'no numeric cell in the window' };
  const observations: Observed[] = [];
  for (const { observedAt, cells } of rows) {
    if (cellState(cells) !== 'values') continue;
    const [wl, st, inf, out] = cells;
    const thou = numberIn(st);
    observations.push({
      observedAt,
      waterLevelM: numberIn(wl),
      storageVolumeM3: thou != null ? thou * 1_000 : null,
      inflowM3s: numberIn(inf),
      outflowM3s: numberIn(out),
    });
  }
  return { state, observations };
}

/** The page's two fixed columns: the universe, whatever the page reads. */
export function aichiEntries(html: string): Entry[] {
  const dams = parseAichiPage(html);
  return DAM_NAMES.map((name, i) => ({
    key: name,
    name,
    pref: PREF_CODE,
    reading: dams
      ? damReading(dams[i] ?? [])
      : { state: 'unreadable', why: 'no <span id="timestamp"> on the page' },
  }));
}

async function fetchPage(): Promise<string> {
  const r = await fetch(DATA_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export default ingestTask(SOURCE_ID, async (log) => {
  let html: string;
  try {
    html = await fetchPage();
  } catch (err) {
    // Both columns are known in advance: a failed fetch still records them.
    const why = err instanceof Error ? err.message : String(err);
    log(`${SOURCE_ID}: ${why}`);
    return {
      entries: DAM_NAMES.map((name) => ({
        key: name,
        name,
        pref: PREF_CODE,
        reading: { state: 'unreadable', why },
      })),
    };
  }
  return { entries: aichiEntries(html) };
});
