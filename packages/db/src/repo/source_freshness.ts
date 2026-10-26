// Per-source staleness: is a source's newest observation older than its
// cadence allows? Read by /api/v1/admin/jobs (`stale_sources`) and the hourly
// quality:freshness-check digest.
//
// threshold = MISSED_RUNS × cadence + publication lag, where
//   cadence  = the longer of the source's poll interval (the longest gap
//              between runs of its cron line) and the longest usual gap
//              between its recent observation stamps (the 90th percentile,
//              so one outage still in the sample doesn't count). The poll
//              bounds how often new rows can arrive; the stamps say how often
//              the provider publishes: the weekend for a weekday-only daily
//              (the median, 24 h, flagged those every weekend), days or weeks
//              for the survey-date sources polled daily (jwa-junpo, the 農林
//              PDFs, the weekly 水道 tables). A source with no cron line has
//              only the stamps to go on.
//   lag      = the median delay between a recent stamp and the first time we
//              stored it (created_at survives the upsert), e.g. ~12 h for a
//              00:00 JST daily value fetched at noon.
// A source's freshnessOverrideHours (packages/core/src/source_registry.ts)
// replaces the threshold where the provider's rhythm is known better than the
// last 20 stamps can show.

import { INGEST_INTERVAL_HOURS } from '@dam/core/crontab';
import { FRESHNESS_OVERRIDE_HOURS } from '@dam/core/sources';
import { sql } from '../client.ts';

/** How many polls (or publications) in a row may bring nothing new. */
const MISSED_RUNS = 3;
/** Recent distinct stamps the cadence and lag are measured over… */
const SAMPLE_STAMPS = 20;
/** …taken within this many days before the newest one. */
const SAMPLE_DAYS = 120;

export type CadenceBasis = 'cron' | 'observed' | 'override';

export interface StaleSource {
  sourceId: string;
  /** null: the source has never written a row. */
  newestObservedAt: Date | null;
  /** The cadence; null when neither a cron line nor the stamps give one (override only). */
  expectedIntervalHours: number | null;
  ageHours: number | null;
  thresholdHours: number;
  /** Where the threshold came from. */
  cadenceBasis: CadenceBasis;
}

interface SourceStats {
  source_id: string;
  newest: Date | null;
  usual_gap_hours: number | null;
  median_lag_hours: number | null;
}

/**
 * Sources whose newest observation is older than their threshold, most
 * overdue first (never-written sources lead). Candidates: every active,
 * observation-providing, non-historical source, plus every ingest cron line
 * whose source has not registered itself yet (each task inserts its
 * source_priorities row on its first run).
 */
export async function staleSources(
  opts: {
    now?: Date;
    cronIntervalHours?: Readonly<Record<string, number>>;
    overrideHours?: Readonly<Record<string, number | null>>;
  } = {},
): Promise<StaleSource[]> {
  const now = opts.now ?? new Date();
  const cron = opts.cronIntervalHours ?? INGEST_INTERVAL_HOURS;
  const overrides = opts.overrideHours ?? FRESHNESS_OVERRIDE_HOURS;

  const stats = await sql<SourceStats[]>`
    WITH candidates AS (
      SELECT source_id FROM source_priorities
      WHERE active AND provides_observations AND NOT historical_only
      UNION
      SELECT c.id FROM unnest(${Object.keys(cron)}::text[]) AS c(id)
      WHERE NOT EXISTS (SELECT 1 FROM source_priorities sp WHERE sp.source_id = c.id)
    )
    SELECT c.source_id, n.newest, s.usual_gap_hours, s.median_lag_hours
    FROM candidates c
    LEFT JOIN LATERAL (
      SELECT MAX(observed_at) AS newest FROM observations WHERE source_id = c.source_id
    ) n ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        percentile_cont(0.9) WITHIN GROUP (ORDER BY gap_hours)::float8 AS usual_gap_hours,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY lag_hours)::float8 AS median_lag_hours
      FROM (
        SELECT
          EXTRACT(EPOCH FROM observed_at - LAG(observed_at) OVER (ORDER BY observed_at)) / 3600
            AS gap_hours,
          GREATEST(EXTRACT(EPOCH FROM first_stored - observed_at) / 3600, 0) AS lag_hours
        FROM (
          SELECT observed_at, MIN(created_at) AS first_stored
          FROM observations
          WHERE source_id = c.source_id
            AND observed_at <= n.newest
            AND observed_at > n.newest - make_interval(days => ${SAMPLE_DAYS})
          GROUP BY observed_at
          ORDER BY observed_at DESC
          LIMIT ${SAMPLE_STAMPS}
        ) stamps
      ) spacing
    ) s ON n.newest IS NOT NULL
  `;

  const stale: StaleSource[] = [];
  for (const r of stats) {
    const override = overrides[r.source_id];
    if (override === null) continue;
    const polled = cron[r.source_id] ?? null;
    const observed = r.usual_gap_hours;
    const interval =
      polled === null ? observed : observed === null ? polled : Math.max(polled, observed);
    const threshold =
      override !== undefined
        ? override
        : interval === null
          ? null
          : MISSED_RUNS * interval + (r.median_lag_hours ?? 0);
    // No cron line and too few stamps to measure: nothing to judge by.
    if (threshold === null) continue;
    const ageHours = r.newest ? (now.getTime() - r.newest.getTime()) / 3_600_000 : null;
    if (ageHours !== null && ageHours <= threshold) continue;
    stale.push({
      sourceId: r.source_id,
      newestObservedAt: r.newest,
      expectedIntervalHours: interval,
      ageHours,
      thresholdHours: threshold,
      cadenceBasis:
        override !== undefined
          ? 'override'
          : polled !== null && (observed === null || polled >= observed)
            ? 'cron'
            : 'observed',
    });
  }
  const overdue = (s: StaleSource): number =>
    s.ageHours === null ? Number.POSITIVE_INFINITY : s.ageHours / s.thresholdHours;
  return stale.sort((a, b) => overdue(b) - overdue(a) || a.sourceId.localeCompare(b.sourceId));
}
