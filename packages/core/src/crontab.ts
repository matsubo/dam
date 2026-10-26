// packages/core/src/crontab.ts — the worker's schedule (apps/worker/src/index.ts
// hands it to graphile-worker). It lives in core because the web app reads it
// too: INGEST_INTERVAL_HOURS below is each source's poll cadence for the
// freshness check (packages/db/src/repo/source_freshness.ts).
// graphile-worker crontab format: https://github.com/graphile/worker
// All times are UTC (graphile-worker doesn't take a timezone). Display time in
// the UI is always JST (Asia/Tokyo) — see lib/format.ts.
//
// Every job that reads a source is declared with that source
// (./source_registry.ts) and turned into a line here; MAINTENANCE_CRONTAB holds
// the jobs that read no source.
//
// Note: graphile-worker's crontab parser only allows [_a-zA-Z][_a-zA-Z0-9:_-]*
// for task identifiers, so we use colons instead of dots.
//
// Every ingest line carries `?jobKey=<task>` (jobKeyMode defaults to replace),
// so each tick replaces its task's pending job: a failing ingest keeps one job
// that retries until the next tick resets it, instead of one job per tick
// each retrying 25 times over ~4 days (a dead upstream piled up ~90 of them).
// Leave max_attempts at the default 25. graphile-worker retries after
// exp(min(attempts, 10)) s, so an hourly job makes ~8 attempts before the
// next tick. A job that exhausted its attempts before the next tick would
// have its key stripped by add_job and stay behind as a dead row, one per
// tick; apps/worker/src/crontab.test.ts checks that every ingest line's
// retries outlast its longest gap between runs.

import { SOURCES } from './sources.ts';

const MAINTENANCE_CRONTAB = `
# Name matching of the master against Damnet / NDI.
0 4 * * * master:match

# Continuous-aggregate full-history refresh — the obs_daily policy only
# covers the trailing 60 days, so freshly backfilled history (mudam) never
# materializes on its own and 平年比 queries read obs_daily. Runs 3 h after
# the mudam tail backfill starts (that run takes ~90 min).
0 8 20 * * aggregates:refresh

# Quality recomputation
30 4 * * * quality:recompute

# Storage rate backfill — runs daily just after quality recompute,
# filling in storage_rate from volume / capacity for sources that don't provide it.
45 4 * * * storageRate:recompute

# Freshness watchdog — every hour, flag any source whose newest observation is
# older than its cadence allows (packages/db/src/repo/source_freshness.ts).
# Posts a digest to DISCORD_FRESHNESS_WEBHOOK if set; else logs warnings only.
35 * * * * quality:freshness-check
`;

export const CRONTAB: string = [
  MAINTENANCE_CRONTAB.trim(),
  ...SOURCES.flatMap((s) => [
    ...(s.ingest ? [`${s.ingest.cron} ${s.ingest.task} ?jobKey=${s.ingest.task}`] : []),
    ...s.jobs.map((j) => [j.cron, j.task, j.payload].filter(Boolean).join(' ')),
  ]),
].join('\n');

/**
 * One crontab field as the values it matches, the way graphile-worker reads it:
 * a comma list of `n`, `a-b` and `*` (optionally `*\/step`). Day of week 7 is 0.
 */
function cronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const wildcard = /^\*(?:\/(\d+))?$/.exec(part);
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    let from: number;
    let to: number;
    let step = 1;
    if (wildcard) {
      from = min;
      to = max;
      step = Number(wildcard[1] ?? 1);
    } else if (range) {
      from = Number(range[1]);
      to = Number(range[2] ?? range[1]);
    } else {
      throw new Error(`crontab: unsupported field "${field}"`);
    }
    const top = max === 6 ? 7 : max;
    if (from < min || to > top || from > to || step < 1) {
      throw new Error(`crontab: field "${field}" is outside ${min}-${max}`);
    }
    for (let v = from; v <= to; v += step) values.add(max === 6 ? v % 7 : v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * Longest gap between two consecutive runs of a schedule, in hours, over a
 * year and a month of UTC days (every month length and every weekday).
 * graphile-worker's day rule: when both day-of-month and day-of-week are
 * restricted, either one matching is enough.
 */
function longestGapHours(fields: string[]): number {
  const [minF, hourF, dateF, monthF, dowF] = fields as [string, string, string, string, string];
  const minutes = cronField(minF, 0, 59);
  const hours = cronField(hourF, 0, 23);
  const dates = cronField(dateF, 1, 31);
  const months = cronField(monthF, 1, 12);
  const dows = cronField(dowF, 0, 6);
  const byDate = dates.length !== 31;
  const byDow = dows.length !== 7;
  const start = Date.UTC(2026, 0, 1);
  let previous: number | null = null;
  let longest = 0;
  for (let day = 0; day < 396; day++) {
    const t = new Date(start + day * 86_400_000);
    if (!months.includes(t.getUTCMonth() + 1)) continue;
    const onDate = dates.includes(t.getUTCDate());
    const onDow = dows.includes(t.getUTCDay());
    if (byDate && byDow ? !(onDate || onDow) : !(onDate && onDow)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const minute = day * 1440 + h * 60 + m;
        if (previous !== null) longest = Math.max(longest, minute - previous);
        previous = minute;
      }
    }
  }
  if (longest === 0) throw new Error(`crontab: "${fields.join(' ')}" runs less than twice a year`);
  return longest / 60;
}

/**
 * Each source's longest gap between runs of its ingest task, in hours, keyed
 * by source id: new rows can't arrive more often than the source is polled.
 */
export const INGEST_INTERVAL_HOURS: Readonly<Record<string, number>> = Object.fromEntries(
  SOURCES.flatMap((s) =>
    s.ingest ? [[s.id, longestGapHours(s.ingest.cron.split(/\s+/))] as const] : [],
  ),
);
