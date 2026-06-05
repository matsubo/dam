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
//   "**" = 欠測, "--" = 未収集 → null. Storage in 千m³.
// Priority 308.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const DATA_URL = process.env.AICHI_KASEN_DAM_URL ?? 'https://www.kasen-aichi.jp/DamHis_10_0_1.html';

const PREF_CODE = '23';
const SOURCE_ID = 'aichi-kasen';

// Ordered to match column positions in the HTML table (left → right).
const DAM_NAMES = ['雨山ダム', '木瀬ダム'] as const;
type DamName = (typeof DAM_NAMES)[number];

// --- types ------------------------------------------------------------------

export interface ParsedRow {
  damName: DamName;
  observedAt: Date;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
}

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

function parseSpanVal(s: string): number | null {
  const t = s.trim();
  if (t === '**' || t === '--' || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function parseAichiPage(html: string): ParsedRow[] {
  const refYear = parseAichiRefYear(html);
  if (!refYear) return [];

  const refDtMatch = html.match(
    /<span id="timestamp">(\d{4})年(\d{2})月(\d{2})日 (\d{2})時(\d{2})分/,
  );
  if (!refDtMatch) return [];
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
  if (Number.isNaN(refDt.getTime())) return [];

  const rows: ParsedRow[] = [];
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

    const vals = [...(rowMatch[2] ?? '').matchAll(cellRe)].map((m) => parseSpanVal(m[1] ?? ''));
    if (vals.length < 8) continue;

    for (let i = 0; i < 2; i++) {
      const base = i * 4;
      const wl = vals[base] ?? null;
      const st = vals[base + 1] ?? null;
      const inf = vals[base + 2] ?? null;
      const out = vals[base + 3] ?? null;
      if (wl === null && st === null && inf === null && out === null) continue;

      rows.push({
        damName: DAM_NAMES[i] as DamName,
        observedAt,
        waterLevelM: wl,
        storageVolumeM3: st !== null ? st * 1_000 : null,
        inflowM3s: inf,
        outflowM3s: out,
      });
    }
  }

  return rows;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 308,
            '愛知県川の防災情報 ダム表 — 2 ダム (UTF-8 HTML, 10分更新)',
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

interface DamMatch {
  damName: string;
  damId: bigint;
}

async function matchMaster(names: string[], log: (s: string) => void): Promise<DamMatch[]> {
  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const out: DamMatch[] = [];

  for (const damName of names) {
    const stem = normalizeName(damName);
    if (!stem) continue;

    let best: { id: bigint; rank: number } | null = null;
    for (const m of masters) {
      const mStem = normalizeName(m.name);
      let rank: number;
      if (m.name === damName) rank = 0;
      else if (mStem === stem) rank = 1;
      else if (m.name === `${stem}ダム`) rank = 2;
      else if (mStem.startsWith(stem)) rank = 3;
      else if (mStem.includes(stem)) rank = 4;
      else continue;
      if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
        best = { id: m.id, rank };
      }
    }

    if (!best) {
      log(`${SOURCE_ID}: no master match for "${damName}"`);
      continue;
    }
    out.push({ damName, damId: best.id });
  }

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

  const html = await r.text();
  const rows = parseAichiPage(html);
  log(`${SOURCE_ID}: parsed ${rows.length} observations`);

  const uniqueNames = [...new Set(rows.map((x) => x.damName))];
  const matches = await matchMaster(uniqueNames, log);
  const idByName = new Map(matches.map((m) => [m.damName, m.damId]));

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = idByName.get(p.damName);
    if (!damId) continue;
    inputs.push({
      observedAt: p.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
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
