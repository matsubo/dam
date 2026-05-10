// Public read-only endpoint for confirming cron health and master-data
// coverage from outside the container. Surfaces:
//
//   - last_runs       Recent successful job completions per task identifier.
//                     graphile-worker doesn't keep a full run-log; we read
//                     last_executed_at + completed counts from
//                     _private_known_crontabs (only the entries declared in
//                     CRONTAB).
//   - active_jobs     Currently-queued / in-flight jobs (attempts, last_error,
//                     run_at). >0 attempts means the job retried.
//   - dam_coverage    Master-data realness counters: how many dams have each
//                     external_id source attached.
//   - observations    Row-count + per-source breakdown (synthetic vs real).
//
// No auth required — these are aggregate counts, no PII or secrets. Useful
// for the operator (and the public roadmap audience) to verify alpha #2
// '定期データ取得の正常化' is actually delivering data.

import { sql } from '@dam/db/client';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface CronEntry {
  identifier: string;
  last_execution: string | null;
}

interface ActiveJob {
  task: string;
  attempts: number;
  max_attempts: number;
  run_at: string;
  last_error: string | null;
}

interface CoverageRow {
  dams_total: number;
  with_damnet: number;
  with_ndi: number;
  with_kasenbosai: number;
}

export async function GET(): Promise<NextResponse> {
  // graphile-worker schema accessor functions (the table layout differs by
  // worker version; falling back gracefully on missing tables).
  const cron = await sql<CronEntry[]>`
    SELECT identifier::text, last_execution::text
    FROM graphile_worker._private_known_crontabs
    ORDER BY identifier
  `.catch(() => [] as CronEntry[]);

  const active = await sql<ActiveJob[]>`
    SELECT
      task_identifier::text   AS task,
      attempts,
      max_attempts,
      run_at::text            AS run_at,
      last_error
    FROM graphile_worker._private_jobs
    ORDER BY run_at
    LIMIT 20
  `.catch(() => [] as ActiveJob[]);

  // Queue-depth breakdown — grouped counts so we can see at a glance which
  // task identifier is wedging the worker (the `active_or_pending_jobs`
  // sample above only shows the first 20). Surfaced after we hit a 12-hour
  // worker stall on 2026-05-11 with no easy way to inspect the queue
  // without psql access.
  const queueDepth = await sql<
    { task: string; pending: number; oldest_run_at: string | null; max_attempts_seen: number }[]
  >`
    SELECT
      task_identifier::text             AS task,
      COUNT(*)::int                     AS pending,
      MIN(run_at)::text                 AS oldest_run_at,
      MAX(attempts)::int                AS max_attempts_seen
    FROM graphile_worker._private_jobs
    GROUP BY task_identifier
    ORDER BY pending DESC
  `.catch(
    () =>
      [] as {
        task: string;
        pending: number;
        oldest_run_at: string | null;
        max_attempts_seen: number;
      }[],
  );

  const coverage = await sql<CoverageRow[]>`
    SELECT
      COUNT(*)::int                                                   AS dams_total,
      COUNT(*) FILTER (WHERE external_ids ? 'damnet')::int            AS with_damnet,
      COUNT(*) FILTER (WHERE external_ids ? 'ndi')::int               AS with_ndi,
      COUNT(*) FILTER (WHERE external_ids ? 'kasenbosai')::int        AS with_kasenbosai
    FROM dams
  `;

  // observations.source_id is TEXT (FK to source_priorities.source_id which
  // is the table PK). Counts limited to last 30 days to keep this cheap on
  // a 6.7 M-row hypertable; total approximate count is reported separately.
  const obsBySource = await sql<{ src: string; rows: number; latest: string | null }[]>`
    SELECT
      o.source_id::text AS src,
      COUNT(*)::int     AS rows,
      MAX(o.observed_at)::text AS latest
    FROM observations o
    WHERE o.observed_at > NOW() - INTERVAL '30 days'
    GROUP BY o.source_id
    ORDER BY rows DESC
  `;
  const totalApprox = await sql<{ n: number }[]>`
    SELECT GREATEST(0, approximate_row_count('observations'))::bigint::int AS n
  `.catch(() => [{ n: 0 }] as { n: number }[]);

  const cov = coverage[0] ?? {
    dams_total: 0,
    with_damnet: 0,
    with_ndi: 0,
    with_kasenbosai: 0,
  };
  const synthSeen = obsBySource.some((r) => r.src === 'synthetic');
  const realSeen = obsBySource.some((r) => r.src !== 'synthetic' && r.rows > 0);

  return NextResponse.json(
    {
      generated_at: new Date().toISOString(),
      cron_schedule: cron,
      active_or_pending_jobs: active,
      queue_depth_by_task: queueDepth,
      dam_coverage: {
        ...cov,
        damnet_pct: cov.dams_total ? Math.round((100 * cov.with_damnet) / cov.dams_total) : 0,
        kasenbosai_pct: cov.dams_total
          ? Math.round((100 * cov.with_kasenbosai) / cov.dams_total)
          : 0,
      },
      observations: {
        approximate_total: totalApprox[0]?.n ?? 0,
        last_30d_by_source: obsBySource,
      },
      data_realness: {
        only_synthetic_seen: synthSeen && !realSeen,
        any_real_observation_in_30d: realSeen,
      },
      _links: {
        self: { href: '/api/v1/admin/jobs' },
        roadmap: { href: '/roadmap' },
      },
    },
    {
      headers: {
        'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
      },
    },
  );
}
