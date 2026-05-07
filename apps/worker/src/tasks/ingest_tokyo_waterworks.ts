// apps/worker/src/tasks/ingest_tokyo_waterworks.ts
//
// First real-observation source. 東京都水道局 publishes a daily-updated
// vol/rate/delta table for the 13 dams that supply Tokyo's drinking water:
//
//   利根川水系 9 dams: 矢木沢 / 奈良俣 / 藤原 / 相俣 / 薗原 / 八ッ場 /
//                      下久保 / 草木 / 渡良瀬貯水池
//   荒川水系   4 dams: 浦山 / 荒川貯水池 / 滝沢 / 二瀬
//   多摩川水系 2 dams: 小河内貯水池 / 村山・山口貯水池
//
// Source: https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen.html
// Format: HTML table, daily granularity. Officially-public open data
//         (no UA gate, no scraping prohibition like kasenbosai/suimon).
//
// Strategy:
//   1. Ensure source_priorities row + 13 dams have
//      external_ids->>'tokyo-waterworks' set on first run (idempotent UPSERT
//      keyed by a manual name → master-name mapping table).
//   2. Fetch + parse the HTML table.
//   3. Insert one observation per dam with
//        source_id      = 'tokyo-waterworks'
//        observed_at    = today 00:00 JST (the page publishes daily)
//        storage_volume = 貯水量(万m³) × 10_000
//        storage_rate   = 貯水率 / 100  (clipped to [0, 1])

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
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
  { tokyoName: '村山・山口貯水池', masterName: '村山', prefCodes: ['13'] },
];

interface ParsedRow {
  tokyoName: string;
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

/** Parse the suigen.html table into one ParsedRow per known dam name. */
export function parseTokyoWaterworksHtml(html: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  const knownNames = new Set(NAME_MAP.map((m) => m.tokyoName));
  // Some capacity cells contain a nested <table> with its own <tr>. The
  // outer-row regex below is non-greedy and would otherwise stop at the
  // nested </tr>, eating the 3-cell inner row instead of the 5-cell outer
  // row. Replace only nested tables that sit inside a <td>, leaving the
  // top-level wrapping tables intact.
  const normalised = html.replace(/(<td\b[^>]*>)\s*<table\b[\s\S]*?<\/table>\s*/g, '$1_nested_');
  const rowMatches = normalised.match(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rowMatches) {
    const cellMatches = row.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g) ?? [];
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
 * Idempotent: stamp external_ids->>'tokyo-waterworks' on the 13 master dams
 * the first time the task runs. Match by (prefCode IN list) AND name LIKE
 * '%<masterName>%' to tolerate the「ダム」/「貯水池」suffix variation.
 */
async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  for (const m of NAME_MAP) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ANY(${m.prefCodes}::text[])
        AND name LIKE ${`%${m.masterName}%`}
      ORDER BY
        CASE WHEN name = ${`${m.masterName}ダム`} THEN 0
             WHEN name = ${`${m.masterName}貯水池`} THEN 1
             ELSE 2 END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    if (!r) {
      log(`tokyo-waterworks: no master match for "${m.tokyoName}" (${m.masterName})`);
      continue;
    }
    matches.push({ tokyoName: m.tokyoName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('tokyo-waterworks', ${m.tokyoName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'tokyo-waterworks', '') <> ${m.tokyoName}
    `;
  }
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

  // Daily granularity → snap observation timestamp to today 00:00 JST so
  // re-runs on the same day idempotently UPSERT (the table's PK is
  // (dam_id, observed_at, source_id)).
  const now = new Date();
  const jstMidnight = new Date(now);
  jstMidnight.setUTCHours(15, 0, 0, 0); // 00:00 JST = 15:00 UTC the previous day
  if (now.getUTCHours() < 15) jstMidnight.setUTCDate(jstMidnight.getUTCDate() - 1);

  const matchByName = new Map(matches.map((m) => [m.tokyoName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.tokyoName);
    if (!damId) continue;
    const storageVolumeM3 = row.storageVolumeWanM3 * 10_000;
    const storageRate = Math.max(0, Math.min(1, row.storageRatePct / 100));
    inputs.push({
      observedAt: jstMidnight,
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
