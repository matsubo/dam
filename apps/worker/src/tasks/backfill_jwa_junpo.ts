// apps/worker/src/tasks/backfill_jwa_junpo.ts
//
// Walks JWA's past 旬報 archive and ingests historical observations for the
// 26 mapped dams. Reuses the parser + name-mapping + observation upserter
// from ingest_jwa_junpo.ts, only the URL and the date enumeration differ.
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

import { upsertObservations } from '@dam/db/repo/observations';
import type { Task } from 'graphile-worker';
import { ensureExternalIds, ensureSourcePriority, parseJwaJunpoHtml } from './ingest_jwa_junpo.ts';

const ARCHIVE_URL_BASE =
  process.env.JWA_JUNPO_ARCHIVE_BASE ?? 'https://www.water.go.jp/honsya/honsya/suigen/junpo/past';

const SLEEP_BETWEEN_FETCHES_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const payload = (rawPayload ?? {}) as BackfillPayload;
  const months = Math.max(1, Math.min(60, payload.months ?? 12));

  await ensureSourcePriority();
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
      const r = await fetch(url, {
        headers: {
          'user-agent':
            process.env.HTTP_USER_AGENT ??
            'DamDataPlatform/0.1 (+https://dam.teraren.com/legal/terms; contact: https://discord.gg/UbWqspWbAk)',
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (r.status !== 200) {
        log(`backfill:jwa-junpo: ${url} HTTP ${r.status}; skip`);
        pagesFail += 1;
        await sleep(SLEEP_BETWEEN_FETCHES_MS);
        continue;
      }
      const html = await r.text();
      const { reportDate, rows: parsed } = parseJwaJunpoHtml(html);
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
        const storageVolumeM3 = row.storageVolumeThouM3 * 1_000;
        const storageRate = Math.max(0, Math.min(1, row.storageRatePct / 100));
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
