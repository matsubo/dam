// apps/worker/src/tasks/ingest_tokyo_waterworks.ts
//
// First real-observation source. 東京都水道局 publishes a vol/rate/delta
// table for the reservoirs that supply Tokyo's drinking water:
//
//   利根川水系 9 dams: 矢木沢 / 奈良俣 / 藤原 / 相俣 / 薗原 / 八ッ場 /
//                      下久保 / 草木 / 渡良瀬貯水池
//   荒川水系   4 dams: 浦山 / 荒川貯水池 / 滝沢 / 二瀬
//   多摩川水系 2 rows: 小河内貯水池 / 村山・山口貯水池 (a three-reservoir total)
//
// Source: https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen.html
// Format: HTML table, one reading a day. Officially-public open data
//         (no UA gate, no scraping prohibition like kasenbosai/suimon).
//
// Strategy:
//   1. Ensure source_priorities row + the 14 single-dam rows have
//      external_ids->>'tokyo-waterworks' set (idempotent, keyed by a manual
//      name → master-name mapping table).
//   2. Fetch + parse the HTML table.
//   3. Upsert one observation per dam with
//        source_id      = 'tokyo-waterworks'
//        observed_at    = the page's 「令和N年M月D日」 at its table's 「N時現在」
//                         (利根川 / 荒川 0時, 多摩川 7時; JST)
//        storage_volume = 貯水量(万m³) × 10_000
//        storage_rate   = 貯水率 / 100  (clipped to [0, 1])
//
// The page is updated on business days only: over a weekend or holiday it
// keeps the last business day's date, so a run then rewrites that day's row
// instead of copying it onto the run date.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.TOKYO_WATERWORKS_URL ?? 'https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen.html';

// Manual mapping: 東京都水道局 listing name → master dam.
// `master_match` resolves dams by (pref_code, normalised name); here I list
// (suggested master slug, fallback search name) so the lookup query is
// unambiguous. `prefCode` narrows the match for collisions.
//
// Slugs come from the bundled master snapshot (verified locally).
const NAME_MAP: Array<{ tokyoName: string; masterName: string; prefCodes: string[] }> = [
  // 利根川水系
  { tokyoName: '矢木沢ダム', masterName: '矢木沢', prefCodes: ['10'] }, // 群馬
  { tokyoName: '奈良俣ダム', masterName: '奈良俣', prefCodes: ['10'] },
  { tokyoName: '藤原ダム', masterName: '藤原', prefCodes: ['10'] },
  { tokyoName: '相俣ダム', masterName: '相俣', prefCodes: ['10'] },
  { tokyoName: '薗原ダム', masterName: '薗原', prefCodes: ['10'] },
  { tokyoName: '八ッ場ダム', masterName: '八ッ場', prefCodes: ['10'] },
  { tokyoName: '下久保ダム', masterName: '下久保', prefCodes: ['10', '11'] }, // 群馬/埼玉
  { tokyoName: '草木ダム', masterName: '草木', prefCodes: ['10'] },
  { tokyoName: '渡良瀬貯水池', masterName: '渡良瀬', prefCodes: ['09', '10', '11'] }, // 栃木/群馬/埼玉
  // 荒川水系
  { tokyoName: '浦山ダム', masterName: '浦山', prefCodes: ['11'] }, // 埼玉
  { tokyoName: '荒川貯水池', masterName: '荒川', prefCodes: ['11'] },
  { tokyoName: '滝沢ダム', masterName: '滝沢', prefCodes: ['11'] },
  { tokyoName: '二瀬ダム', masterName: '二瀬', prefCodes: ['11'] },
  // 多摩川水系
  { tokyoName: '小河内貯水池', masterName: '小河内', prefCodes: ['13'] }, // 東京
];

// 村山・山口貯水池 totals three reservoirs: 貯水容量 3,435 万m³ is the 有効 of
// 村山上 (298.3), 村山下 (1,184.3) and 山口 (1,952.8, 埼玉). No master row
// holds that figure, so it is recorded as published, bound to no dam and
// not stored; migration 0162 gives it a not_dam_reason.
const RESERVOIR_TOTAL = '村山・山口貯水池';

interface ParsedRow {
  tokyoName: string;
  observedAt: Date;
  storageVolumeWanM3: number; // 万m³
  storageRatePct: number; // %
  prevDeltaWanM3: number | null;
}

/**
 * Strip HTML tags and decode entities. Robust enough for a vetted source page;
 * not a general-purpose HTML sanitiser.
 */
function textOf(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function parseNum(s: string): number | null {
  const cleaned = s.replace(/[,\s]/g, '');
  if (!cleaned || cleaned === '―' || cleaned === '-') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse suigen.html into one ParsedRow per known dam name, each dated by the
 * page. In document order the page carries its date (「令和8年9月25日(金曜日)」,
 * 令和N = 2018+N), then one table per 水系 whose caption gives the hour
 * (「利根川水系　0時現在」, 「多摩川水系　7時現在」), then that table's rows.
 * The weekday keeps a nav link's 「令和5年3月31日事業廃止」 from passing for
 * the page date. Rows without a date and an hour above them are dropped.
 */
export function parseTokyoWaterworksHtml(html: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.tokyoName));
  // Some capacity cells contain a nested <table> with its own <tr>. The
  // outer-row regex below is non-greedy and would otherwise stop at the
  // nested </tr>, eating the 3-cell inner row instead of the 5-cell outer
  // row. Replace only nested tables that sit inside a <td>, leaving the
  // top-level wrapping tables intact.
  const normalised = html.replace(/(<td\b[^>]*>)\s*<table\b[\s\S]*?<\/table>\s*/g, '$1_nested_');
  const tokens = normalised.matchAll(
    /令和(\d+)年(\d+)月(\d+)日[(（][月火水木金土日]曜日[)）]|(\d+)時現在|<tr\b[^>]*>[\s\S]*?<\/tr>/g,
  );
  let date: { year: number; month: number; day: number } | null = null;
  let hour: number | null = null;
  for (const t of tokens) {
    if (t[1] !== undefined) {
      date = { year: 2018 + Number(t[1]), month: Number(t[2]), day: Number(t[3]) };
      continue;
    }
    if (t[4] !== undefined) {
      hour = Number(t[4]);
      continue;
    }
    if (date === null || hour === null) continue;
    const cellMatches = t[0].match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g) ?? [];
    const cells = cellMatches.map((c) => textOf(c.replace(/^<t[hd][^>]*>|<\/t[hd]>$/g, '')));
    if (cells.length < 5) continue;
    const name = cells[0] ?? '';
    if (!knownNames.has(name)) continue;
    const volume = parseNum(cells[2] ?? '');
    const rate = parseNum(cells[3] ?? '');
    const delta = parseNum(cells[4] ?? '');
    if (volume == null || rate == null) continue;
    out.push({
      tokyoName: name,
      // JST = UTC+9.
      observedAt: new Date(Date.UTC(date.year, date.month - 1, date.day, hour - 9)),
      storageVolumeWanM3: volume,
      storageRatePct: rate,
      prevDeltaWanM3: delta,
    });
  }
  return out;
}

interface DamMatch {
  tokyoName: string;
  damId: bigint;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('tokyo-waterworks', 300,
            '東京都水道局 / 水源情報 (real, daily, official open data)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

/**
 * Master row for a listing: match by (prefCode IN list) AND name LIKE
 * '%<masterName>%' to tolerate the「ダム」/「貯水池」suffix variation. A row
 * already stamped with the listing keeps it; a redeveloped dam's （元）/（再）
 * twins share the ELSE rank so chooseRanked picks the current one (#79).
 */
export async function findMaster(m: (typeof NAME_MAP)[number]): Promise<BindableMaster | null> {
  const rows = await sql<(BindableMaster & { rank: number })[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>'tokyo-waterworks' AS stamp,
           CASE WHEN name = ${`${m.masterName}ダム`} THEN 0
                WHEN name = ${`${m.masterName}貯水池`} THEN 1
                ELSE 2 END AS rank
    FROM dams
    WHERE pref_code = ANY(${m.prefCodes}::text[])
      AND name LIKE ${`%${m.masterName}%`}
    ORDER BY rank, id
  `;
  return chooseRanked(rows, m.tokyoName);
}

/**
 * Stamp external_ids->>'tokyo-waterworks' on the listed master dams, and
 * record every published row (the 村山・山口 total too) in the universe.
 */
export async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const m of NAME_MAP) {
    const r = await findMaster(m);
    universe.push({
      externalId: m.tokyoName,
      name: m.tokyoName,
      // A multi-code entry (渡良瀬 straddles 栃木/群馬/埼玉) is a LIKE-narrowing
      // hint, not an attribution, and pref_code is COALESCE-sticky once
      // written.
      prefCode: m.prefCodes.length === 1 ? (m.prefCodes[0] ?? null) : null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`tokyo-waterworks: no master match for "${m.tokyoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ tokyoName: m.tokyoName, damId: r.id });
    await bindExternalId(r.id, 'tokyo-waterworks', m.tokyoName);
  }
  // Spans 東京 and 埼玉 (山口), so no prefecture either.
  universe.push({
    externalId: RESERVOIR_TOTAL,
    name: RESERVOIR_TOTAL,
    prefCode: null,
    resolvedDamId: null,
  });
  await recordUniverse('tokyo-waterworks', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`tokyo-waterworks: matched ${matches.length}/${NAME_MAP.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status !== 200) {
    log(`tokyo-waterworks: HTTP ${r.status} from ${PAGE_URL}; aborting`);
    return;
  }
  const html = await r.text();
  const parsed = parseTokyoWaterworksHtml(html);
  log(`tokyo-waterworks: parsed ${parsed.length} dam rows`);

  const matchByName = new Map(matches.map((m) => [m.tokyoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.tokyoName);
    if (!damId) continue;
    const storageVolumeM3 = row.storageVolumeWanM3 * 10_000;
    const storageRate = Math.max(0, Math.min(1, row.storageRatePct / 100));
    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: 'tokyo-waterworks',
      storageVolumeM3,
      storageRate,
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
    `tokyo-waterworks done: parsed=${parsed.length} matched=${matches.length} written=${written}`,
  );
};

export default task;
