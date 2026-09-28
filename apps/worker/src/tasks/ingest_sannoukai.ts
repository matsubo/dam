// apps/worker/src/tasks/ingest_sannoukai.ts
//
// 山王海土地改良区「ダムの状況」— 山王海ダム / 葛丸ダム (東北農政局の国営
// 親子ダム, 管理 山王海土地改良区) の貯水量, weekly.
//
// Source: https://sannoukai.jp/condition/ — 「毎週月曜日に更新します。」 The
// readings are not in the page text: the WordPress template writes them into
// inline script, which draws the reservoir picture in the browser,
//   var sMax = 3840;  // 山王海ダム　最大 3840
//   var kMax = 500;   // 葛丸ダム　　最大  500
//   var sNow = 1833;
//   var kNow = 432;
// in 万㎥. Each dam block (<div id="dam_s">, <div id="dam_k">) is headed
// 「山王海ダム情報」/「葛丸ダム情報」, and its id suffix names the variable. A
// value of 0 is the page's no-data marker (it shows the text 'zero' instead
// of a level), so it is recorded as has_data=false, not as an empty
// reservoir.
//
// Date: the date the page shows is the viewer's clock (`new Date()`), not the
// survey's, so it is useless. The survey date is taken from the page's own
// WordPress REST record (<link rel="alternate" type="application/json">),
// whose modified_gmt moves when the readings are edited (2026-09-28 08:46
// JST, a Monday). Stamped 00:00 JST of that date, like the other survey-date
// sources; a same-day correction lands on the same row.
//
// Rate: not stored. The page's 貯水率 is its own script dividing by the
// constants above (3840 = 山王海's 総貯水容量), not a published figure; the
// site derives the rate from the stored volume as for any untrusted source.
//
// Both dams are on kasenbosai (310), which has carried no reading since
// 2026-08-04 and lists them as empty (has_data=false). Priority 277 stays
// below it, so a kasenbosai reading wins again whenever there is one.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.SANNOUKAI_URL ?? 'https://sannoukai.jp/condition/';

const PREF_CODE = '03';
const SOURCE_ID = 'sannoukai';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

// --- parsing ----------------------------------------------------------------

export interface ParsedDam {
  /** Heading minus 「情報」 (「山王海ダム」); also the stamp and universe key. */
  name: string;
  /** null when the script has no value or the page's 0 no-data marker. */
  storageVolumeM3: number | null;
  /** The page itself says there is no reading (its 0 marker). */
  markedEmpty: boolean;
}

export function parseSannoukaiPage(html: string): ParsedDam[] {
  const dams: ParsedDam[] = [];
  for (const m of html.matchAll(
    /<div id="dam_([a-z]+)"[^>]*>[\s\S]*?<h3 class="dam_name">([^<]+?)情報<\/h3>/g,
  )) {
    const key = m[1] as string;
    const name = (m[2] as string).normalize('NFKC').trim();
    const value = html.match(new RegExp(`var ${key}Now\\s*=\\s*(\\d+(?:\\.\\d+)?)\\s*;`))?.[1];
    const man = value === undefined ? null : Number(value);
    dams.push({
      name,
      storageVolumeM3: man !== null && man > 0 ? Math.round(man * 10_000) : null,
      markedEmpty: man === 0,
    });
  }
  return dams;
}

/** The page's WordPress REST record, from its alternate JSON link. */
export function findRestUrl(html: string): string | null {
  for (const link of html.matchAll(/<link\b[^>]*>/g)) {
    const tag = link[0];
    if (!/rel="alternate"/.test(tag) || !/type="application\/json"/.test(tag)) continue;
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (href?.includes('/wp-json/')) return href;
  }
  return null;
}

/** 00:00 JST of the JST date the record was last edited. */
export function observedAtFromRest(record: unknown): Date | null {
  const gmt = (record as { modified_gmt?: unknown })?.modified_gmt;
  if (typeof gmt !== 'string') return null;
  const edited = new Date(`${gmt}Z`);
  if (Number.isNaN(edited.getTime())) return null;
  const jst = new Date(edited.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), -9));
}

// --- matching ---------------------------------------------------------------

function stemOf(s: string): string {
  return s
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/ダム$/, '')
    .trim();
}

/** The stamped row, else the dam of the same name (live twin of （元）/（再）). */
export function chooseMaster(name: string, masters: BindableMaster[]): bigint | null {
  const stamped = stampedMaster(masters, name);
  if (stamped) return stamped.id;
  const stem = stemOf(name);
  let best: BindableMaster | null = null;
  for (const m of masters) {
    if (stemOf(m.name) !== stem) continue;
    if (!best || preferMaster(m, best)) best = m;
  }
  return best?.id ?? null;
}

// --- DB helpers -------------------------------------------------------------

async function ensureSourcePriority(): Promise<void> {
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, active)
    VALUES (${SOURCE_ID}, 277,
            '山王海土地改良区 ダムの状況 — 山王海ダム・葛丸ダム貯水量 (週次 HTML)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function fetchOk(url: string): Promise<Response | null> {
  const r = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  return r.status === 200 ? r : null;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const page = await fetchOk(PAGE_URL);
  if (!page) {
    log(`${SOURCE_ID}: ${PAGE_URL} did not return 200; aborting`);
    return;
  }
  const html = await page.text();
  const dams = parseSannoukaiPage(html);
  log(`${SOURCE_ID}: parsed ${dams.length} dams`);

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damByName = new Map<string, bigint>();
  // Everything the page lists, matched or not, before any skip.
  const universe: UniverseRow[] = [];
  for (const d of dams) {
    const damId = chooseMaster(d.name, masters);
    universe.push({
      externalId: d.name,
      name: d.name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      // false only on the page's own no-data marker; an unreadable value may
      // be this parser breaking, so it stays unknown.
      ...(d.storageVolumeM3 !== null ? { hasData: true } : d.markedEmpty ? { hasData: false } : {}),
    });
    if (!damId) {
      log(`${SOURCE_ID}: no master match for "${d.name}"`);
      continue;
    }
    damByName.set(d.name, damId);
    await bindExternalId(damId, SOURCE_ID, d.name);
  }
  await recordUniverse(SOURCE_ID, universe);

  if (dams.length === 0) {
    throw new Error(`${SOURCE_ID}: no dam blocks on ${PAGE_URL} — layout change?`);
  }

  const restUrl = findRestUrl(html);
  const rest = restUrl ? await fetchOk(restUrl) : null;
  const observedAt = rest ? observedAtFromRest(await rest.json()) : null;
  if (!observedAt) {
    throw new Error(`${SOURCE_ID}: no edit date from ${restUrl ?? '(no REST link)'}`);
  }

  const inputs = [] as Parameters<typeof upsertObservations>[0];
  for (const d of dams) {
    const damId = damByName.get(d.name);
    if (!damId || d.storageVolumeM3 === null) continue;
    inputs.push({
      observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: d.storageVolumeM3,
      storageRate: null,
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
    `${SOURCE_ID} done: parsed=${dams.length} matched=${damByName.size} written=${written} at=${observedAt.toISOString()}`,
  );
};

export default task;
