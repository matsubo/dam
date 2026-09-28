// apps/worker/src/tasks/ingest_shimonoseki_suido.ts
//
// 下関市上下水道局「水源状況についてお知らせします」 — the city's three
// reservoirs, updated a few times a week.
//
// Source: https://www.city.shimonoseki.lg.jp/site/water/5617.html
// Static UTF-8 HTML. A line 「令和8年9月25日現在の下関市の水源状況…」 (the
// date is split across <strong> tags) above one table captioned 水源の貯水量:
//   施設名 | 満水量「2,050,000立方メートル」 | 貯水量「507,000立方メートル」 | 貯水率「24.7%」
// for 木屋川ダム / 湯の原ダム / 内日貯水池, then a 合計 row. The notes say the
// figures are 「当日午前0時現在」, so rows are stamped 00:00 JST of that date.
// The 降水量 table below it is not read.
//
//   湯の原ダム  written. The printed 満水量 follows the season and the rate
//               divides by it: out of the 洪水期 2,050,000 (the master's
//               有効貯水容量, NDI 2024; 507,000 / 24.7 % on 2026-09-25), in the
//               洪水期 (6/15–9/15) the 1,620,000 cap (699,000 / 43.1 % on
//               2025-07-14, which the static capacity would show as 34.1 %).
//               Trusted as a season-aware native rate in 0107.
//   木屋川ダム  universe only. kasenbosai and yamaguchi-bousai publish it every
//               10 minutes, and this page's 満水量 (19,440,000; 17,332,000 in
//               the 洪水期) sits below the master's 有効 21,080,000, so its rate
//               is on another basis and a once-a-day volume adds nothing.
//   内日貯水池  universe only, unresolved. 1,900,000 is 内日第1 (有効 1,000,000)
//               + 内日第2 (900,000) as one figure; writing it to either would show
//               a volume the dam cannot hold. The stem 内日 also names the 県's
//               内日ダム (NDI 2028), a different dam, so it is refused by name.
//
// Licence: 著作権・リンク (/site/userguide/51553.html) allows 複製・引用・転載 with
// 出所の明示. robots.txt disallows only /site/iju-project/.
//
// Priority 293. Cron daily 07:46 UTC (16:46 JST): the page is edited during the
// day with that morning's 0時 figures.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.SHIMONOSEKI_SUIDO_URL ?? 'https://www.city.shimonoseki.lg.jp/site/water/5617.html';

const PREF_CODE = '35';
const SOURCE_ID = 'shimonoseki-suido';

/** One figure for several master dams (内日第1 + 内日第2); binds to none. */
const COMBINED: Readonly<Record<string, true>> = { 内日貯水池: true };
/** Recorded in the universe, not written: a 10-minute source covers it. */
const UNIVERSE_ONLY: Readonly<Record<string, true>> = { 木屋川ダム: true };

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 施設名 as published ("湯の原ダム"); also the stamp and universe key. */
  name: string;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNumber(cell: string): number | null {
  const m = cellText(cell).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 「令和8年9月25日現在」 → 00:00 JST of that date, as UTC. */
function parseAsOf(html: string): Date | null {
  const m = cellText(html)
    .replace(/\s+/g, '')
    .match(/令和(元|\d{1,2})年(\d{1,2})月(\d{1,2})日現在/);
  if (!m) return null;
  const year = 2018 + (m[1] === '元' ? 1 : Number(m[1]));
  const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), -9));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseShimonosekiSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)]
    .map((t) => t[1] ?? '')
    .find((t) => /<th[^>]*>[^<]*貯水率/.test(t));
  const rows: ParsedRow[] = [];
  for (const tr of (table ?? '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    const name = cellText(cells[0] ?? '').replace(/\s/g, '');
    if (cells.length !== 4 || !name || /合計/.test(name)) continue;
    const rate = firstNumber(cells[3] ?? '');
    rows.push({
      name,
      storageVolumeM3: firstNumber(cells[2] ?? ''),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseAsOf(html), rows };
}

// --- matching ---------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(貯水池|ダム)$/, '')
    .trim();
}

/**
 * Master dam for a published 施設名: a COMBINED figure binds to none; else the
 * row stamped with it keeps it; else an exact stem beats a prefix. A name whose
 * best rank reaches several different dams binds to none; the （元）/（再）
 * twins of one dam share a stem and go to the live one.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  if (COMBINED[name]) return null;
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = normalizeName(name);
  if (!stem) return null;
  let best: { m: BindableMaster; rank: number; stems: string[] } | null = null;
  for (const m of masters) {
    const mStem = normalizeName(m.name);
    let rank: number;
    if (mStem === stem) rank = 0;
    else if (mStem.startsWith(stem)) rank = 1;
    else continue;
    if (best === null || rank < best.rank) {
      best = { m, rank, stems: [mStem] };
    } else if (rank === best.rank) {
      best = { m: preferMaster(m, best.m) ? m : best.m, rank, stems: [...best.stems, mStem] };
    }
  }
  if (best === null || new Set(best.stems).size > 1) return null;
  return best.m.id;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 293,
            '下関市上下水道局 水源状況 — 湯の原ダム (貯水量+貯水率, 当日0時, 週数回更新)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

/** Records the whole published list; returns the dams to write, by 施設名. */
async function matchMaster(
  rows: ParsedRow[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const damId = chooseMaster(r.name, masters);
    universe.push({ externalId: r.name, name: r.name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no single master dam for "${r.name}"`);
      continue;
    }
    if (UNIVERSE_ONLY[r.name]) continue;
    damByName.set(r.name, damId);
    await bindExternalId(damId, SOURCE_ID, r.name);
  }

  await recordUniverse(SOURCE_ID, universe);
  return damByName;
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

  const { observedAt, rows } = parseShimonosekiSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「令和…日現在」 line on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} facilities at ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: date found but no 貯水量 table rows — layout change?`);
  }

  const damByName = await matchMaster(rows, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.name);
    if (!damId || (p.storageVolumeM3 === null && p.storageRate === null)) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
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
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);
};

export default task;
