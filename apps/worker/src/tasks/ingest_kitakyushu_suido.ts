// apps/worker/src/tasks/ingest_kitakyushu_suido.ts
//
// 北九州市上下水道局「北九州市の水源状況」 — the city's 10 water sources, daily.
//
//   油木 / ます渕 / 耶馬渓 (大分) / 力丸 / 頓田 / 畑 / 白木 / 道原 / 松ヶ江 /
//   遠賀川河口堰
//
// Source: https://www.city.kitakyushu.lg.jp/suidou/s00900011.html
// Static UTF-8 HTML. One table captioned 「2026年9月25日　午前9時現在」 (JST);
// rows are <th>場所</th> 水位「61.47メートル」 | 貯水量（万立方メートル） | 貯水率「34.9％」,
// followed by 本日貯水量合計 / 同日貯水量合計平年値, which are not facilities.
// 畑 prints the whole reservoir with 「（うち北九州分 284）」 under it; the
// first figure is the reservoir's, and that is the one stored. The page says
// it is refreshed on weekdays around 16:00 (not on weekends / holidays).
//
// Rate: 貯水率 is the city's own 利水 basis. Back-solved from the 2026-09-25
// table against the master's 有効貯水容量:
//   own dams   道原 40/87.8 % = 45.6 (有効 45.0) 万m³, 松ヶ江 52/34.9 % = 149
//              (150), 白木 16/49.7 % = 32.2 (32.4), 畑 376/54.4 % = 691 (691)
//   多目的     油木 589/40.8 % = 1,444 (有効 1,745), ます渕 726/64.0 % = 1,134
//              (1,344), 力丸 462/42.8 % = 1,079 (1,250)
// so the multipurpose dams divide by their 利水 pool, below the annual
// capacity the site would otherwise use (trusted in 0098).
//
// 頓田貯水池 is one figure (890 万m³ / 97.3 % → 915) for what the master holds
// as two dams, 頓田第1（再） 440 + 頓田第2（再） 475 万m³. Writing it to either
// would show a volume the dam cannot hold, so chooseMaster refuses a name that
// reaches several different master dams; it is recorded unresolved.
//
// Priority 300: kasenbosai (310) keeps 油木/ます渕/力丸/畑/耶馬溪, which it
// publishes every 10 minutes; this feed is the only one for 白木 / 道原 /
// 松ヶ江 / 遠賀川河口堰, and sits above kyushu-nousei (279) and oita-nourin
// (282) on 油木 / 耶馬溪. Cron daily 08:50 UTC (17:50 JST).

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.KITAKYUSHU_SUIDO_URL ?? 'https://www.city.kitakyushu.lg.jp/suidou/s00900011.html';

/** 耶馬渓 is in 大分; every other facility is in 福岡. */
const PREF_CODES = ['40', '44'];
const DEFAULT_PREF_CODE = '40';
const SOURCE_ID = 'kitakyushu-suido';

// --- parsing ----------------------------------------------------------------

export interface ParsedRow {
  /** 場所 as published ("松ヶ江貯水池"); also the stamp and universe key. */
  name: string;
  waterLevelM: number | null;
  storageVolumeM3: number | null;
  /** 貯水率 as a 0..1 fraction. */
  storageRate: number | null;
}

function cellText(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[０-９．，]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .trim();
}

/** First number in the cell ("376 （うち北九州分 284）" → 376); none → null. */
function firstNumber(cell: string): number | null {
  const m = cellText(cell).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 「2026年9月25日　午前9時現在」 (JST) → UTC. */
function parseCaption(html: string): Date | null {
  const caption = html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1];
  if (!caption) return null;
  const m = cellText(caption).match(
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*(午前|午後)?\s*(\d{1,2})時(?:\s*(\d{1,2})分)?/,
  );
  if (!m) return null;
  const hour = Number(m[5]) + (m[4] === '午後' && Number(m[5]) < 12 ? 12 : 0);
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour - 9, Number(m[6] ?? 0)),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseKitakyushuSuigen(html: string): {
  observedAt: Date | null;
  rows: ParsedRow[];
} {
  const rows: ParsedRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? '';
    const name = cellText(body.match(/<th[^>]*>([\s\S]*?)<\/th>/)?.[1] ?? '');
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1] ?? '');
    if (!name || cells.length !== 3 || /合計|平年/.test(name)) continue;
    const volume = firstNumber(cells[1] ?? '');
    const rate = firstNumber(cells[2] ?? '');
    rows.push({
      name,
      waterLevelM: firstNumber(cells[0] ?? ''),
      storageVolumeM3: volume === null ? null : Math.round(volume * 10_000),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return { observedAt: parseCaption(html), rows };
}

// --- matching ---------------------------------------------------------------

function normalizeName(s: string): string {
  return (
    s
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/(貯水池|ダム)$/, '')
      // 耶馬渓 (page) vs 耶馬溪 (master) — the same name in new and old kanji.
      .replace(/溪/g, '渓')
      .trim()
  );
}

/**
 * Master dam for a published 場所: the row stamped with it keeps it; else an
 * exact stem beats a prefix. A name whose best rank reaches several different
 * dams (頓田 → 頓田第1 + 頓田第2) is a combined figure and binds to none; the
 * （元）/（再） twins of one dam share a stem and go to the live one.
 */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
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
    VALUES (${SOURCE_ID}, 300,
            '北九州市上下水道局 北九州市の水源状況 — 10 水源 (水位+貯水量+貯水率, 平日日次)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function matchMaster(
  rows: ParsedRow[],
  log: (s: string) => void,
): Promise<Map<string, bigint>> {
  const masters = await sql<(BindableMaster & { prefCode: string })[]>`
    SELECT id, name, pref_code AS "prefCode", completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code IN ${sql(PREF_CODES)} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];

  for (const r of rows) {
    const damId = chooseMaster(r.name, masters);
    const prefCode = masters.find((m) => m.id === damId)?.prefCode ?? DEFAULT_PREF_CODE;
    universe.push({ externalId: r.name, name: r.name, prefCode, resolvedDamId: damId });
    if (!damId) {
      log(`${SOURCE_ID}: no single master dam for "${r.name}"`);
      continue;
    }
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

  const { observedAt, rows } = parseKitakyushuSuigen(await r.text());
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no 「…時現在」 caption on ${PAGE_URL} — layout change?`);
  }
  log(`${SOURCE_ID}: parsed ${rows.length} facilities at ${observedAt.toISOString()}`);
  if (rows.length === 0) {
    throw new Error(`${SOURCE_ID}: caption found but no facility rows — layout change?`);
  }

  const damByName = await matchMaster(rows, log);

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const p of rows) {
    const damId = damByName.get(p.name);
    if (!damId) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: p.storageVolumeM3,
      storageRate: p.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: p.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${rows.length} matched=${damByName.size} written=${written}`);
};

export default task;
