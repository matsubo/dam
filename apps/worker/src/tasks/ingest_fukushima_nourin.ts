// apps/worker/src/tasks/ingest_fukushima_nourin.ts
//
// 福島県 農林水産部「県内の主要農業関係ダムの貯水状況」— 農業用ダム 29 基。
//
// Source:
//   https://www.pref.fukushima.lg.jp/sec/36045d/noutikannri010.html
//
// Distinct from `fukushima-kasen` (土木部・河川): that feed carries the 11
// prefecture-managed river dams hourly, this one carries the *agricultural*
// dams — 溜池 / 調整池 / 土地改良区管理ダム — that never appear there.
//
// Format: one HTML table, columns
//   ダム名 | 所在市町村 | 管理受託者等 | 貯水率（かんがい用水） | 平年比 | 備考
// The survey date lives in an <h3>令和N年M月D日現在</h3> above the table.
// Values are percent strings; only 貯水率 is usable (no volume, no level).
//
// Cadence: roughly biweekly (survey dates, not a clock feed). Priority 285 —
// below jwa-junpo (290, 旬報) since this is coarser still, so any hourly
// source wins on a dam both cover. The rate is 利水(かんがい用水)基準 per the
// page's own footnote, so trusted_rate_basis is set (see migration 0040).

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.FUKUSHIMA_NOURIN_URL ??
  'https://www.pref.fukushima.lg.jp/sec/36045d/noutikannri010.html';

const PREF_CODE = '07';
const SOURCE_ID = 'fukushima-nourin';

/** Upper sanity bound for a published 貯水率, in percent. */
const MAX_PLAUSIBLE_PCT = 200;

export interface ParsedRow {
  /** Name exactly as the page prints it, e.g. 「岳ダム」「深田調整池」. */
  fukushimaName: string;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number;
}

// --- parsing ----------------------------------------------------------------

/**
 * Parse 「令和N年M月D日現在」 → JST midnight of that day.
 * 令和 (Reiwa) year N → Gregorian 2018 + N.
 */
export function parseNourinReportDate(html: string): Date | null {
  const m = html.match(/令和(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const yr = 2018 + Number(m[1]);
  const mo = Number(m[2]);
  const day = Number(m[3]);
  if (!mo || !day) return null;
  // JST midnight = 15:00 UTC the previous day.
  const d = new Date(Date.UTC(yr, mo - 1, day - 1, 15, 0, 0, 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

function cleanCell(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

function tableRows(html: string): string[][] {
  return Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)).map((tr) =>
    Array.from((tr[1] ?? '').matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((c) =>
      cleanCell(c[1] ?? ''),
    ),
  );
}

/** 「97.9%」 → 97.9. Prose cells ("調査対象外" 等) return null. */
function parsePercent(cell: string): number | null {
  const m = cell.match(/^(\d+(?:\.\d+)?)\s*[%％]$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** Dam-like names only — excludes the 県平均 summary row and the footnote row. */
const NAME_RE = /(ダム|調整池|溜池|池|沼)$/;

export function parseFukushimaNourinHtml(html: string): {
  reportDate: Date | null;
  rows: ParsedRow[];
} {
  const reportDate = parseNourinReportDate(html);
  const rows: ParsedRow[] = [];

  for (const cells of tableRows(html)) {
    if (cells.length < 4) continue;
    const name = cells[0] ?? '';
    if (!NAME_RE.test(name)) continue;

    const pct = parsePercent(cells[3] ?? '');
    if (pct === null) continue;
    // A published 0.0% here is never an operating value: the page annotates it
    // (鴻の巣ダム is drained for construction). Dropping it keeps us out of the
    // phantom-zero hole migrations 0038/0039 had to dig us out of.
    if (pct <= 0 || pct > MAX_PLAUSIBLE_PCT) continue;

    rows.push({ fukushimaName: name, storageRate: pct / 100 });
  }

  return { reportDate, rows };
}

// --- name matching ----------------------------------------------------------

/**
 * Strip ダム + （元）/（再）-style annotations and fold ノ/の, which the page
 * and the master spell differently (feed 山ノ入ダム vs master 山の入).
 * 調整池 / 溜池 / 池 / 沼 are kept — they are part of the name, not a suffix.
 */
export function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .replace(/ノ/g, 'の')
    .trim();
}

/**
 * Reservoir-kind suffixes the master sometimes omits: 大深沢調整池 (feed) is
 * 大深沢 in the master. Only multi-character suffixes are stripped — dropping a
 * bare 池/沼 would turn 新池 into 新 and match half the prefecture.
 */
const KIND_SUFFIX_RE = /(調整池|貯水池|ため池|溜池)$/;

/** Best master dam for a feed stem; exact name beats stem beats substring. */
export function chooseMaster(
  feedName: string,
  masters: { id: bigint; name: string }[],
): bigint | null {
  const stem = normalizeName(feedName);
  if (!stem) return null;
  const bareStem = stem.replace(KIND_SUFFIX_RE, '');
  const hasBareStem = bareStem.length >= 2 && bareStem !== stem;

  let best: { id: bigint; rank: number } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (m.name === feedName) rank = 0;
    else if (mStem === stem) rank = 1;
    else if (m.name === `${stem}ダム`) rank = 2;
    else if (mStem.startsWith(stem)) rank = 3;
    else if (mStem.includes(stem)) rank = 4;
    else if (hasBareStem && mStem === bareStem) rank = 5;
    else continue;
    if (!best || rank < best.rank || (rank === best.rank && m.id < best.id)) {
      best = { id: m.id, rank };
    }
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active, trusted_rate_basis)
    VALUES (${SOURCE_ID}, 285,
            '福島県 農林水産部 県内の主要農業関係ダムの貯水状況 — 農業用ダム 29 基, 隔週 (貯水率のみ)',
            true, true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority           = EXCLUDED.priority,
          description        = EXCLUDED.description,
          active             = EXCLUDED.active,
          trusted_rate_basis = EXCLUDED.trusted_rate_basis
  `;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const r = await fetch(PAGE_URL, {
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

  const { reportDate, rows } = parseFukushimaNourinHtml(await r.text());
  if (!reportDate) {
    log(`${SOURCE_ID}: no survey date in the page; aborting`);
    return;
  }
  log(`${SOURCE_ID}: parsed ${rows.length} dam rows for ${reportDate.toISOString()}`);

  const masters = await sql<{ id: bigint; name: string }[]>`
    SELECT id, name FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  let unmatched = 0;
  for (const p of rows) {
    const damId = chooseMaster(p.fukushimaName, masters);
    if (!damId) {
      unmatched += 1;
      log(`${SOURCE_ID}: no master match for "${p.fukushimaName}"`);
      continue;
    }
    inputs.push({
      observedAt: reportDate,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: null,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(
    `${SOURCE_ID} done: parsed=${rows.length} matched=${inputs.length} unmatched=${unmatched} written=${written}`,
  );
};

export default task;
