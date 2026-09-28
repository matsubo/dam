// apps/worker/src/tasks/ingest_kudamatsu_suido.ts
//
// 下松市上下水道局「水源情報」 — the city's two source reservoirs, both 山口県営
// on 末武川 (山口/35). About monthly: the 2026-09-04 edit shows 温見 at
// 令和8年9月3日0時 and 末武川 at 令和8年9月1日0時.
//
// Source: https://www.city.kudamatsu.lg.jp/sui-gyoumu/~k-water/damu_001.html
// Static UTF-8 HTML. Per dam an <h3>県営○○ダムの状況</h3>, a <p>令和N年M月D日H時現在</p>
// (JST) and a th/td key-value table: 水位「271.57m」 | 満水位, 貯水量
// 「4,319,680立法メートル」 | 総貯水量, 利水量 | 有効貯水量, 貯水率「95.6％」, and
// monthly 降水量合計 (a month-to-date sum, not an interval rainfall; not stored).
// The yearly damu20XX.pdf links are charts without printed levels.
//
// 温見 (NDI 1997) is published nowhere else. Its 貯水率 is 貯水量 / 総貯水量
// (4,319,680 / 4,520,000 = 95.6 %), and 4,520,000 is also the master's
// active_capacity_m3, i.e. the denominator the site already divides by — so
// the source stays untrusted (0098's matsue-suido reasoning) and the stored
// rate agrees with the derived one.
//
// 末武川 is recorded in the universe only: kasenbosai (310) and
// yamaguchi-bousai (308) publish it every 10 minutes, and this page's rate is
// on another pool (12,722,000 / 92.1 % = 13.8 M m³ against the master's 有効
// 18.77 M m³), so a monthly point would add nothing but a second basis.
//
// Priority 293. Cron daily 02:47 UTC (11:47 JST).

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL =
  process.env.KUDAMATSU_SUIDO_URL ??
  'https://www.city.kudamatsu.lg.jp/sui-gyoumu/~k-water/damu_001.html';

const SOURCE_ID = 'kudamatsu-suido';
const PREF_CODE = '35';
/** Published here but better covered elsewhere (see the header). */
const UNIVERSE_ONLY: Record<string, true> = { 末武川ダム: true };

// --- parsing ----------------------------------------------------------------

export interface ParsedDam {
  /** Heading without 県営 / の状況 ("温見ダム"); also the stamp and universe key. */
  name: string;
  observedAt: Date | null;
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
    .replace(/\s+/g, ' ')
    .trim();
}

/** First number in the cell ("4,319,680立法メートル" → 4319680); a marker → null. */
function firstNumber(cell: string): number | null {
  const m = cellText(cell).match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 「令和8年9月3日0時現在」 (JST; 令和元年, 西暦 and a missing 時 allowed) → UTC. */
function parseStamp(text: string): Date | null {
  const m = cellText(text).match(
    /(令和)?\s*(元|\d{1,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(?:(\d{1,2})\s*時)?\s*現在/,
  );
  if (!m) return null;
  const n = m[2] === '元' ? 1 : Number(m[2]);
  const year = m[1] ? 2018 + n : n;
  const d = new Date(Date.UTC(year, Number(m[3]) - 1, Number(m[4]), Number(m[5] ?? 0) - 9));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseKudamatsuSuigen(html: string): ParsedDam[] {
  const dams: ParsedDam[] = [];
  const chunks = html.split(/<h3[^>]*>/).slice(1);
  for (const chunk of chunks) {
    const heading = cellText(chunk.split(/<\/h3>/)[0] ?? '');
    const name = heading.match(/^(?:県営)?\s*(.+?)の状況$/)?.[1];
    if (!name) continue;
    const table = chunk.match(/<table[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
    const values = new Map<string, string>();
    for (const m of table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
      values.set(cellText(m[1] ?? ''), m[2] ?? '');
    }
    const rate = firstNumber(values.get('貯水率') ?? '');
    dams.push({
      name,
      observedAt: parseStamp(chunk.split(/<table/)[0] ?? ''),
      waterLevelM: firstNumber(values.get('水位') ?? ''),
      storageVolumeM3: firstNumber(values.get('貯水量') ?? ''),
      storageRate: rate === null ? null : rate / 100,
    });
  }
  return dams;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 293,
            '下松市上下水道局 水源情報 — 県営温見ダム (水位+貯水量+貯水率, 月次程度)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

/** The 山口 master for a heading: its stamp first, then exact stem, then prefix. */
async function findDamId(name: string): Promise<bigint | null> {
  const stem = name.replace(/ダム$/, '');
  const rows = await sql<(BindableMaster & { rank: number })[]>`
    SELECT id, name, completed_year AS "completedYear",
           external_ids->>${SOURCE_ID} AS stamp,
           CASE WHEN name = ${stem} THEN 0 ELSE 1 END AS rank
    FROM dams
    WHERE pref_code = ${PREF_CODE}
      AND (name LIKE ${`${stem}%`} OR external_ids->>${SOURCE_ID} = ${name})
    ORDER BY rank, id
  `;
  return chooseRanked(rows, name)?.id ?? null;
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

  const dams = parseKudamatsuSuigen(await r.text());
  log(`${SOURCE_ID}: parsed ${dams.length} dams (${dams.map((d) => d.name).join(', ')})`);
  if (dams.length === 0) {
    throw new Error(`${SOURCE_ID}: no 「…ダムの状況」 section on ${PAGE_URL} — layout change?`);
  }

  // Every published dam, matched or not and skipped or not, so /coverage can
  // tell "published, not linked" from "nobody publishes it".
  const universe: UniverseRow[] = [];
  const inputs = [] as Parameters<typeof upsertObservations>[0];
  const undated: string[] = [];
  let matched = 0;
  for (const d of dams) {
    const damId = await findDamId(d.name);
    universe.push({ externalId: d.name, name: d.name, prefCode: PREF_CODE, resolvedDamId: damId });
    if (UNIVERSE_ONLY[d.name]) continue;
    if (!damId) {
      log(`${SOURCE_ID}: no master dam for "${d.name}" (pref ${PREF_CODE})`);
      continue;
    }
    matched++;
    await bindExternalId(damId, SOURCE_ID, d.name);
    if (!d.observedAt) {
      undated.push(d.name);
      continue;
    }
    if (d.waterLevelM === null && d.storageVolumeM3 === null && d.storageRate === null) {
      log(`${SOURCE_ID}: ${d.name} has no values at ${d.observedAt.toISOString()}; skip`);
      continue;
    }
    inputs.push({
      observedAt: d.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: d.storageVolumeM3,
      storageRate: d.storageRate,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: d.waterLevelM,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    });
  }
  await recordUniverse(SOURCE_ID, universe);

  const written = await upsertObservations(inputs);
  log(`${SOURCE_ID} done: parsed=${dams.length} matched=${matched} written=${written}`);
  // Thrown only after the universe and the dated dams are stored, so one lost
  // stamp does not also hide the list or the other dam.
  if (undated.length > 0) {
    throw new Error(`${SOURCE_ID}: no 「…現在」 stamp for ${undated.join(', ')} — layout change?`);
  }
};

export default task;
