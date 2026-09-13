// apps/worker/src/tasks/ingest_tottori.ts
//
// Seventh real-observation source. 鳥取県ダム諸量情報システム publishes every
// dam's latest values in 10分データ全ダム一覧 (`/{dam}/data10all.php`), refreshed
// every 10 minutes server-side. Five prefectural dams covered:
//
//   賀祥 (kasho), 朝鍋 (asanabe), 佐治川 (sajigawa),
//   東郷 (togo),  百谷 (momodani).
//
// Page is EUC-JP encoded; we decode via TextDecoder. One row per dam:
//
//   佐治川ダム | 時間雨量 0 | 累計雨量 0 | ダム水位 382.57 | 流入量 1.04 |
//   放流量 0.12 | 有効貯水量 111 | 有効貯水容量 1880 | 貯水率 6 | 空容量 1663 | …
//
// 貯水率 is 有効貯水容量-based — 朝鍋ダムの諸量ページ states 「貯水率＝有効貯水量
// ／有効貯水容量」 — and the denominator is printed on the row, so each rate can
// be checked against its own volume.
//
// The top page's <area alt> blocks carried the same fields and were the original
// source, but 賀祥ダム's block disagrees with the rest of the site: at
// 2026/09/11 05:30 it read 有効貯水量 452 千m³ / 貯水率 07 % while this table, the
// dam's own 諸量ページ and 鳥取県防災Web all read 1,212 千m³ / 18 % for the same
// water level. Only 賀祥 is affected; the other four agree exactly.
//
// Cron: hourly at :09.

import { sql } from '@dam/db/client';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

// 10分データ全ダム一覧 — one request for all five dams. Only served from inside
// a dam directory; every copy renders the same table.
const PAGE_URL = process.env.TOTTORI_DAM_URL ?? 'http://tottoridam.jp/kasho/data10all.php';

interface DamCfg {
  tottoriName: string;
  masterName: string;
}

const DAMS: DamCfg[] = [
  { tottoriName: '賀祥ダム', masterName: '賀祥' },
  { tottoriName: '朝鍋ダム', masterName: '朝鍋' },
  { tottoriName: '佐治川ダム', masterName: '佐治川' },
  { tottoriName: '東郷ダム', masterName: '東郷' },
  { tottoriName: '百谷ダム', masterName: '百谷' },
];

const PREF_CODE = '31';

interface ParsedRow {
  tottoriName: string;
  observedAt: Date;
  waterLevelM: number | null;
  inflowM3s: number | null;
  outflowM3s: number | null;
  storageVolumeM3: number | null;
  /** 有効貯水容量 the row's own 貯水率 is divided by (千m³ → m³). */
  effectiveCapacityM3: number | null;
  storageRate: number | null;
  rainfallMm: number | null;
}

function parseNum(s: string): number | null {
  const t = s.replace(/[,\s　]/g, '');
  if (!t || t === '―' || t === '-' || t === '欠測') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse 「2026/05/15 22:50」 (or 「2026/5/15 23:00」 — Tottori uses both)
 *  as JST → UTC. */
function parseJstStamp(s: string): Date | null {
  const m = s.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]) - 9, Number(m[5]), 0, 0),
  );
}

/** Strip tags and entities from one table cell. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[　]/g, ' ')
    .trim();
}

/**
 * How far a published 貯水率 may sit from 有効貯水量 / 有効貯水容量 and still be
 * kept. The site prints whole percents, so rounding alone is worth half a point;
 * every row on 2026-09-11 09:20 landed within 0.5 points of its own ratio.
 */
const RATE_TOLERANCE = 0.05;

/**
 * Parse 10分データ全ダム一覧 (`/{dam}/data10all.php`) — every dam in one table,
 * with the 有効貯水容量 each 貯水率 is divided by printed on the same row.
 *
 * Columns are located by their header label rather than by position so a new
 * 下流水位 column cannot silently shift the values.
 */
export function parseTottoriAllPage(html: string, knownNames: Set<string>): ParsedRow[] {
  const table = /<table[^>]*class="data10"[\s\S]*?<\/table>/.exec(html)?.[0];
  if (!table) return [];

  const stamp = /<p[^>]*id="date"[^>]*>([^<]*)<\/p>/.exec(html)?.[1] ?? '';
  const observedAt = parseJstStamp(stamp);
  if (!observedAt) return [];

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => m[1] ?? '');
  const header = rows.find((r) => r.includes('<th'));
  if (!header) return [];
  // Header labels line up with the data cells one-for-one, the leading blank
  // cell included, so their index is the data cell's index.
  const labels = [...header.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) =>
    cellText(m[1] ?? ''),
  );
  const indexOf = (label: string): number => labels.findIndex((l) => l.startsWith(label));

  const idx = {
    rainfall: indexOf('時間雨量'),
    level: indexOf('ダム水位'),
    inflow: indexOf('流入量'),
    outflow: indexOf('放流量'),
    volume: indexOf('有効貯水量'),
    capacity: indexOf('有効貯水容量'),
    rate: indexOf('貯水率'),
  };

  const out: ParsedRow[] = [];
  for (const row of rows) {
    if (row.includes('<th')) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => cellText(m[1] ?? ''));
    const name = cells[0] ?? '';
    if (!knownNames.has(name)) continue;

    const at = (i: number): number | null => (i < 0 ? null : parseNum(cells[i] ?? ''));
    const volThou = at(idx.volume);
    const capThou = at(idx.capacity);
    const ratePct = at(idx.rate);

    // 鳥取県 publishes 貯水率 = 有効貯水量 / 有効貯水容量 (stated on the 朝鍋 page),
    // so every row carries its own check: keep a rate only while it still matches
    // the volume and capacity printed beside it. Note this would NOT have caught
    // the top page's 賀祥 block — 452 千m³ against 6,690 is 6.8 %, and it published
    // 07 % — because volume and rate were wrong together. That one only showed up
    // against 空容量 (452 + 5,478 ≠ 6,690), which is not a usable invariant here:
    // 東郷 misses it by 6 % on a good row (204 + 485 vs 650).
    const rate = ratePct != null ? Math.max(0, Math.min(1, ratePct / 100)) : null;
    const implied = volThou != null && capThou ? volThou / capThou : null;
    const consistent =
      rate == null || implied == null || Math.abs(implied - rate) <= RATE_TOLERANCE;

    out.push({
      tottoriName: name,
      observedAt,
      waterLevelM: at(idx.level),
      inflowM3s: at(idx.inflow),
      outflowM3s: at(idx.outflow),
      storageVolumeM3: volThou != null ? volThou * 1_000 : null,
      effectiveCapacityM3: capThou != null ? capThou * 1_000 : null,
      storageRate: consistent ? rate : null,
      rainfallMm: at(idx.rainfall),
    });
  }
  return out;
}

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES ('tottori-dam', 307,
            '鳥取県ダム諸量情報システム — hourly, 5 dams (賀祥/朝鍋/佐治川/東郷/百谷)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

interface DamMatch {
  tottoriName: string;
  damId: bigint;
}

async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const c of DAMS) {
    const rows = await sql<{ id: bigint; name: string }[]>`
      SELECT id, name FROM dams
      WHERE pref_code = ${PREF_CODE}
        AND name LIKE ${`%${c.masterName}%`}
      ORDER BY
        CASE
          WHEN name = ${c.masterName} THEN 0
          WHEN name = ${`${c.masterName}ダム`} THEN 1
          ELSE 5
        END,
        id
      LIMIT 1
    `;
    const r = rows[0];
    universe.push({
      externalId: c.tottoriName,
      name: c.tottoriName,
      prefCode: PREF_CODE,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`tottori-dam: no master match for ${c.tottoriName}`);
      continue;
    }
    matches.push({ tottoriName: c.tottoriName, damId: r.id });
    await sql`
      UPDATE dams
      SET external_ids = COALESCE(external_ids, '{}'::jsonb)
                       || jsonb_build_object('tottori-dam', ${c.tottoriName}::text)
      WHERE id = ${r.id}
        AND COALESCE(external_ids->>'tottori-dam', '') <> ${c.tottoriName}
    `;
  }
  await recordUniverse('tottori-dam', universe);
  return matches;
}

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();
  const matches = await ensureExternalIds(log);
  log(`tottori-dam: matched ${matches.length}/${DAMS.length} master dams`);

  const r = await fetch(PAGE_URL, {
    headers: {
      'user-agent':
        process.env.HTTP_USER_AGENT ??
        'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200) {
    log(`tottori-dam: HTTP ${r.status}; aborting`);
    return;
  }
  // Page is EUC-JP — decode explicitly.
  const buf = await r.arrayBuffer();
  const html = new TextDecoder('euc-jp').decode(buf);
  const parsed = parseTottoriAllPage(html, new Set(DAMS.map((d) => d.tottoriName)));
  log(`tottori-dam: parsed ${parsed.length} dam rows`);

  const matchByName = new Map(matches.map((m) => [m.tottoriName, m.damId]));
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const row of parsed) {
    const damId = matchByName.get(row.tottoriName);
    if (!damId) continue;
    inputs.push({
      observedAt: row.observedAt,
      damId,
      sourceId: 'tottori-dam',
      storageVolumeM3: row.storageVolumeM3,
      storageRate: row.storageRate,
      inflowM3s: row.inflowM3s,
      outflowM3s: row.outflowM3s,
      waterLevelM: row.waterLevelM,
      rainfallMm: row.rainfallMm,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  const written = await upsertObservations(inputs);
  log(`tottori-dam done: parsed=${parsed.length} matched=${matches.length} written=${written}`);
};

export default task;
