// apps/worker/src/tasks/ingest_yonezawa_heiya.ts
//
// 米沢平野土地改良区「用水状況」— 水窪ダム (東北農政局, 管理 米沢平野土地改良区)
// の貯水量, weekly.
//
// Source: https://www.yonezawa-heiya.or.jp/pages/150/ (水利・施設情報 > 用水状況).
// The page shows the latest reading as a slider caption,
//   「2026.9.28現在、貯水量は 20,343.9千m3です。」
// updated 「毎週月曜日（祝日･休日の場合は翌日）」. Its 「令和８年度」 link opens the
// fiscal-year archive (pages/169 for R8), one caption per week from 4月 on,
// so every run re-reads the whole year and the first run backfills it. The
// archive link is discovered from pages/150, never pinned: each 年度 gets a
// new page id (R7 is pages/163).
//
// No time of day is published, so a reading is stamped 00:00 JST of its date.
// Volume only: the page prints no level and no rate.
//
// Cadence: weekly all year; the 令和７年度 archive (pages/163) has 51 readings,
// 2025.4.7 – 2026.3.30, the longest gap 14 days (年末年始). The derived
// freshness threshold covers that, so there is no override.
//
// 水窪 is in no other feed (not on kasenbosai, not in 山形県's bousai table),
// so priority 278 ties with nothing on it.

import { type BindableMaster, preferMaster, stampedMaster } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';

const PAGE_URL = process.env.YONEZAWA_HEIYA_URL ?? 'https://www.yonezawa-heiya.or.jp/pages/150/';

const PREF_CODE = '06';
const SOURCE_ID = 'yonezawa-heiya';

const USER_AGENT =
  process.env.HTTP_USER_AGENT ??
  'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)';

// --- parsing ----------------------------------------------------------------

export interface ParsedReading {
  observedAt: Date;
  storageVolumeM3: number;
}

/**
 * Every 「Y.M.D現在、貯水量は N千m3」 caption, one reading per date. NFKC first:
 * the captions are hand-typed and sometimes carry a full-width 「ｍ」.
 */
export function parseYonezawaReadings(html: string): ParsedReading[] {
  const text = html.normalize('NFKC');
  const byDate = new Map<number, ParsedReading>();
  for (const m of text.matchAll(
    /(\d{4})\.(\d{1,2})\.(\d{1,2})現在、貯水量は\s*([\d,]+(?:\.\d+)?)\s*千m3/g,
  )) {
    const observedAt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), -9));
    const thousands = Number((m[4] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(thousands)) continue;
    byDate.set(observedAt.getTime(), {
      observedAt,
      storageVolumeM3: Math.round(thousands * 1000),
    });
  }
  return [...byDate.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

/** The dam the page reports on, from its 「水窪ダム用水状況」 heading text node. */
export function parseDamName(html: string): string | null {
  for (const node of html.split(/<[^>]*>/)) {
    const m = node
      .normalize('NFKC')
      .trim()
      .match(/^(\S+ダム)用水状況$/);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** The current fiscal year's archive: the first 「令和…年度」 link on the page. */
export function findArchiveUrl(html: string, base: string): string | null {
  for (const a of html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const label = (a[2] ?? '')
      .replace(/<[^>]*>/g, '')
      .normalize('NFKC')
      .trim();
    if (/^令和\d+年度/.test(label) && a[1]) return new URL(a[1], base).toString();
  }
  return null;
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
    VALUES (${SOURCE_ID}, 278,
            '米沢平野土地改良区 用水状況 — 水窪ダム貯水量 (週次 HTML)',
            true)
    ON CONFLICT (source_id) DO UPDATE
      SET priority    = EXCLUDED.priority,
          description = EXCLUDED.description,
          active      = EXCLUDED.active
  `;
}

async function fetchHtml(url: string): Promise<string | null> {
  const r = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  return r.status === 200 ? await r.text() : null;
}

// --- task -------------------------------------------------------------------

const task: Task = async (_payload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  await ensureSourcePriority();

  const html = await fetchHtml(PAGE_URL);
  if (html === null) {
    log(`${SOURCE_ID}: ${PAGE_URL} did not return 200; aborting`);
    return;
  }
  const name = parseDamName(html);
  if (!name) throw new Error(`${SOURCE_ID}: no 「…ダム用水状況」 heading on ${PAGE_URL}`);

  const readings = new Map<number, ParsedReading>();
  for (const r of parseYonezawaReadings(html)) readings.set(r.observedAt.getTime(), r);
  const archiveUrl = findArchiveUrl(html, PAGE_URL);
  const archive = archiveUrl ? await fetchHtml(archiveUrl) : null;
  if (archive === null) log(`${SOURCE_ID}: archive ${archiveUrl ?? '(no link)'} not read`);
  else for (const r of parseYonezawaReadings(archive)) readings.set(r.observedAt.getTime(), r);
  log(`${SOURCE_ID}: parsed ${readings.size} weekly readings for ${name}`);

  const masters = await sql<BindableMaster[]>`
    SELECT id, name, completed_year AS "completedYear", external_ids->>${SOURCE_ID} AS stamp
    FROM dams WHERE pref_code = ${PREF_CODE} ORDER BY id
  `;
  const damId = chooseMaster(name, masters);
  // The page publishes this one dam; record it before the unmatched return.
  const universe: UniverseRow[] = [
    {
      externalId: name,
      name,
      prefCode: PREF_CODE,
      resolvedDamId: damId,
      ...(readings.size > 0 ? { hasData: true } : {}),
    },
  ];
  await recordUniverse(SOURCE_ID, universe);
  if (!damId) {
    log(`${SOURCE_ID}: no master match for "${name}"`);
    return;
  }
  await bindExternalId(damId, SOURCE_ID, name);

  const written = await upsertObservations(
    [...readings.values()].map((r) => ({
      observedAt: r.observedAt,
      damId,
      sourceId: SOURCE_ID,
      storageVolumeM3: r.storageVolumeM3,
      storageRate: null,
      inflowM3s: null,
      outflowM3s: null,
      waterLevelM: null,
      rainfallMm: null,
      rawSnapshotId: null,
      qualityFlag: 0,
    })),
  );
  log(`${SOURCE_ID} done: parsed=${readings.size} matched=1 written=${written}`);

  if (readings.size === 0) {
    throw new Error(`${SOURCE_ID}: no 「現在、貯水量は」 caption on ${PAGE_URL} — layout change?`);
  }
};

export default task;
