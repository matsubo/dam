// apps/worker/src/tasks/backfill_jwa_junpo.ts
//
// Walks JWA's past 旬報 archive and ingests historical observations for the
// 26 mapped dams. Reuses the parser and the dam list from ingest_jwa_junpo.ts;
// the live task binds through the ingest run, the backfill (outside the run)
// binds here with its own name matching.
//
// Past archive URL pattern:
//   https://www.water.go.jp/honsya/honsya/suigen/junpo/past/{YYYY}/junpo{YYYYMMDD}.html
// where YYYYMMDD is one of 0101, 0111, 0121, 0201, 0211, 0221, … (the 1st,
// 11th, and 21st of each month — JWA's publication days). The page itself
// reports values measured one day before each cut-off, so the parser uses
// the 「令和N年M月D日」 header to set observed_at, not the URL date.
//
// Trigger:
//   await graphile.add_job('backfill:jwa-junpo', { months: 12 });
// Default if no payload: 12 months.
//
// Polite throttling: 2-second delay between fetches (~36 requests for 12
// months → ~72 s total). The task tolerates per-page failures (404 or
// non-200) and continues with the next date.

import { type BindableMaster, chooseRanked } from '@dam/core/dam_binding';
import { sql } from '@dam/db/client';
import { bindExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { recordUniverse, type UniverseRow } from '@dam/db/repo/source_universe';
import type { Task } from 'graphile-worker';
import { numberIn } from '../ingest/cells.ts';
import { liveUpstream } from '../ingest/upstream.ts';
import { JUNPO_DAMS, parseJwaJunpoHtml } from './ingest_jwa_junpo.ts';

const ARCHIVE_URL_BASE =
  process.env.JWA_JUNPO_ARCHIVE_BASE ?? 'https://www.water.go.jp/honsya/honsya/suigen/junpo/past';

const SLEEP_BETWEEN_FETCHES_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface DamMatch {
  jwaName: string;
  damId: bigint;
}

/**
 * Idempotent: bind each listed station to one master dam and stamp
 * external_ids->>'jwa-junpo' there (and nowhere else). Match by (prefCode IN
 * list) AND name LIKE '%<masterName>%', preferring 「<masterName>ダム」, then
 * the bare name, then 「再」/「元」/「再開発」, then 「貯水池」. A row already
 * stamped keeps the station; a （元）/（再） pair goes to whichever structure
 * is in service (chooseRanked).
 */
export async function ensureExternalIds(log: (s: string) => void): Promise<DamMatch[]> {
  const matches: DamMatch[] = [];
  // What this source publishes, matched or not — recorded so /coverage can
  // say "they publish it, we failed to link it" instead of guessing.
  const universe: UniverseRow[] = [];
  for (const [jwaName, dam] of Object.entries(JUNPO_DAMS)) {
    const masterName = dam.masterName ?? jwaName.replace(/ダム$/, '');
    const candidates = await sql<(BindableMaster & { rank: number })[]>`
      SELECT id, name, completed_year AS "completedYear",
             external_ids->>'jwa-junpo' AS stamp,
             CASE
               WHEN name = ${`${masterName}ダム`} THEN 0
               WHEN name = ${masterName} THEN 1
               WHEN name LIKE ${`${masterName}（再）%`} THEN 2
               WHEN name LIKE ${`${masterName}（元）%`} THEN 2
               WHEN name LIKE ${`${masterName}（再開発）%`} THEN 2
               WHEN name = ${`${masterName}貯水池`} THEN 3
               ELSE 5
             END AS rank
      FROM dams
      WHERE pref_code = ANY(${dam.prefs}::text[])
        AND name LIKE ${`%${masterName}%`}
    `;
    const r = chooseRanked(candidates, jwaName);
    universe.push({
      externalId: jwaName,
      name: jwaName,
      // A multi-code entry (下久保 straddles 群馬/埼玉) is a LIKE-narrowing
      // hint, not an attribution, and pref_code is COALESCE-sticky once
      // written.
      prefCode: dam.prefs.length === 1 ? (dam.prefs[0] ?? null) : null,
      resolvedDamId: r?.id ?? null,
    });
    if (!r) {
      log(`jwa-junpo: no master match for "${jwaName}" (${masterName})`);
      continue;
    }
    matches.push({ jwaName, damId: r.id });
    await bindExternalId(r.id, 'jwa-junpo', jwaName);
  }
  await recordUniverse('jwa-junpo', universe);
  return matches;
}

interface BackfillPayload {
  /** Number of months back to walk. Default 12. */
  months?: number;
}

/**
 * Generate JWA publication dates (1st / 11th / 21st of each month) for the
 * `months` window ending at "today". Excludes the current 10-day window since
 * that's served by the live ingest task.
 */
export function enumerateBackfillDates(months: number, today = new Date()): Date[] {
  const dates: Date[] = [];
  const yearNow = today.getUTCFullYear();
  const monthNow = today.getUTCMonth(); // 0-based
  for (let i = 0; i < months; i += 1) {
    // Walk months backwards from the previous full month.
    const target = new Date(Date.UTC(yearNow, monthNow - i - 1, 1));
    const y = target.getUTCFullYear();
    const m = target.getUTCMonth(); // 0-based
    for (const day of [1, 11, 21]) {
      dates.push(new Date(Date.UTC(y, m, day)));
    }
  }
  return dates;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function urlFor(date: Date): string {
  const y = date.getUTCFullYear();
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return `${ARCHIVE_URL_BASE}/${y}/junpo${y}${m}${d}.html`;
}

const task: Task = async (rawPayload, helpers) => {
  const log = (s: string): void => helpers.logger.info(s);
  const upstream = liveUpstream('jwa-junpo');
  const payload = (rawPayload ?? {}) as BackfillPayload;
  const months = Math.max(1, Math.min(60, payload.months ?? 12));

  const matches = await ensureExternalIds(log);
  log(`backfill:jwa-junpo: matched ${matches.length} master dams; months=${months}`);

  const matchByName = new Map(matches.map((m) => [m.jwaName, m.damId]));
  const dates = enumerateBackfillDates(months);
  let pagesOk = 0;
  let pagesEmpty = 0;
  let pagesFail = 0;
  let observationsWritten = 0;

  for (const date of dates) {
    const url = urlFor(date);
    try {
      // A non-2xx page throws; the catch below counts it failed and moves on.
      const html = (await upstream.fetch(url)).text();
      const page = parseJwaJunpoHtml(html);
      const reportDate = page.reportDate;
      // Only rows printing 利水容量, 貯水量 and 貯水率 are written.
      const parsed = page.rows.flatMap((row) => {
        const volumeThou = numberIn(row.storageVolumeThouM3);
        const ratePct = numberIn(row.storageRatePct);
        return row.storageCapacityThouM3 == null || volumeThou == null || ratePct == null
          ? []
          : [{ jwaName: row.jwaName, volumeThou, ratePct }];
      });
      if (!reportDate || parsed.length === 0) {
        log(
          `backfill:jwa-junpo: ${url} parsed=${parsed.length} reportDate=${reportDate?.toISOString() ?? '(missing)'}; skip`,
        );
        pagesEmpty += 1;
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
        continue;
      }
      const inputs = [] as Parameters<typeof upsertObservations>[0];
      for (const row of parsed) {
        const damId = matchByName.get(row.jwaName);
        if (!damId) continue;
        const storageVolumeM3 = row.volumeThou * 1_000;
        const storageRate = Math.max(0, Math.min(1, row.ratePct / 100));
        inputs.push({
          observedAt: reportDate,
          damId,
          sourceId: 'jwa-junpo',
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
      observationsWritten += written;
      pagesOk += 1;
      log(`backfill:jwa-junpo: ${url} ${reportDate.toISOString().slice(0, 10)} written=${written}`);
    } catch (err) {
      pagesFail += 1;
      log(`backfill:jwa-junpo: ${url} ERROR ${(err as Error).message}; continuing`);
    }
    await sleep(SLEEP_BETWEEN_FETCHES_MS);
  }

  log(
    `backfill:jwa-junpo done: pages ok=${pagesOk} empty=${pagesEmpty} fail=${pagesFail}; observations written=${observationsWritten}`,
  );
};

export default task;
