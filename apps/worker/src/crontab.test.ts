import { describe, expect, test } from 'bun:test';
import { CRONTAB, INGEST_INTERVAL_HOURS } from '@dam/core/crontab';
import { type ParsedCronItem, parseCrontab } from 'graphile-worker';

// graphile-worker's failJobs reschedules a failed job at
// run_at + exp(least(attempts, 10)) seconds, attempts counting the runs so
// far. A job allowed N attempts therefore waits this long in total between
// its first and its last attempt.
function totalBackoffSeconds(maxAttempts: number): number {
  let total = 0;
  for (let attempts = 1; attempts < maxAttempts; attempts++) {
    total += Math.exp(Math.min(attempts, 10));
  }
  return total;
}

// Longest gap, in seconds, between two consecutive runs of the item over a
// 31-day window (wrapping around), minute by minute in UTC like the scheduler.
function longestGapSeconds(match: ParsedCronItem['match']): number {
  const start = Date.UTC(2026, 0, 1);
  const minutes = 31 * 24 * 60;
  const fires: number[] = [];
  for (let m = 0; m < minutes; m++) {
    const t = new Date(start + m * 60_000);
    const digest = {
      min: t.getUTCMinutes(),
      hour: t.getUTCHours(),
      date: t.getUTCDate(),
      month: t.getUTCMonth() + 1,
      dow: t.getUTCDay(),
    };
    if (match(digest)) fires.push(m);
  }
  const first = fires[0];
  const last = fires[fires.length - 1];
  if (first === undefined || last === undefined) return Number.POSITIVE_INFINITY;
  let gap = first + minutes - last;
  for (let i = 1; i < fires.length; i++) {
    gap = Math.max(gap, (fires[i] ?? 0) - (fires[i - 1] ?? 0));
  }
  return gap * 60;
}

const ingestItems = parseCrontab(CRONTAB)
  .filter((item) => item.task.startsWith('ingest:'))
  .map((item) => [item.identifier, item] as const);

describe('CRONTAB ingest lines', () => {
  // A failing ingest used to retry 25 times over ~4 days while every later
  // tick queued another job, so one dead upstream piled up ~90 of them.
  test.each(ingestItems)('%s: the next tick replaces the pending job', (_id, item) => {
    expect(item.options.jobKey).toBe(item.task);
    expect(item.options.jobKeyMode).toBe('replace');
  });

  // add_job strips the key from a keyed job that has used up its attempts and
  // inserts a new one, so a job that gives up before the next tick is left
  // behind as a dead row, one per tick while the upstream stays down.
  test.each(ingestItems)(
    '%s: a failing job is still retrying when the next tick comes',
    (_id, item) => {
      expect(totalBackoffSeconds(item.options.maxAttempts ?? 25)).toBeGreaterThan(
        longestGapSeconds(item.match),
      );
    },
  );
});

// INGEST_INTERVAL_HOURS parses the crontab itself (the web app can't load
// graphile-worker); the freshness check reads it as each source's cadence.
describe('INGEST_INTERVAL_HOURS', () => {
  test.each(ingestItems)('%s: agrees with the scheduler', (_id, item) => {
    const sourceId = item.task === 'ingest:kasenbosai-v2' ? 'kasenbosai' : item.task.slice(7);
    expect(INGEST_INTERVAL_HOURS[sourceId]).toBe(longestGapSeconds(item.match) / 3600);
  });
});
