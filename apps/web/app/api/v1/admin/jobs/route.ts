// Admin endpoint for cron health, coverage stats, and one-shot job dispatch.
//
// GET  — public read-only stats (no auth required):
//   - cron_schedule   Last execution timestamps per crontab identifier.
//   - active_jobs     Currently-queued / in-flight jobs.
//   - queue_depth     Per-task pending counts for quick queue inspection.
//   - dam_coverage    external_id source attachment counts.
//   - observations    Row-count + per-source breakdown (last 30d).
//
// POST — enqueue a one-shot graphile-worker job (requires ADMIN_SECRET):
//   Authorization: Bearer <ADMIN_SECRET>
//   Body: { "task": "match:kasenbosai", "payload": {} }
//   Returns: { "job_id": number }
//
// ADMIN_SECRET is set in the worker/web environment. If unset, POST is
// disabled (returns 503) to avoid accidental exposure.

import { sql } from '@dam/db/client';
import { type NextRequest, NextResponse } from 'next/server';
import type { JSONValue } from 'postgres';

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

  // obs_daily health — diagnoses why 平年比 (seasonal norm) may be empty.
  // The continuous aggregate's refresh policy only maintains the trailing
  // 60 days, so historical buckets near the current DOY only exist if a full
  // refresh (aggregates:refresh) has run. This surfaces whether that history
  // is materialized and how many dams can actually produce a seasonal norm.
  const obsDaily = await sql<
    {
      total: number;
      older_than_60d: number;
      min_day: string | null;
      max_day: string | null;
      dams_with_doy_history: number;
      dams_with_fresh_obs: number;
      dams_with_both: number;
      both_slugs: string[];
    }[]
  >`
    WITH od_old AS (
      SELECT dam_id, day, last_storage_volume_m3 FROM obs_daily
      WHERE day < NOW() - INTERVAL '60 days'
    ),
    doy AS (
      SELECT dam_id
      FROM od_old
      WHERE last_storage_volume_m3 IS NOT NULL
        AND LEAST(
              ABS(EXTRACT(DOY FROM day) - EXTRACT(DOY FROM NOW())),
              366 - ABS(EXTRACT(DOY FROM day) - EXTRACT(DOY FROM NOW()))
            ) <= 7
      GROUP BY dam_id
      HAVING COUNT(*) >= 5
    ),
    fresh AS (
      SELECT DISTINCT o.dam_id
      FROM observations o JOIN dams d ON d.id = o.dam_id
      WHERE o.storage_volume_m3 IS NOT NULL
        AND d.active_capacity_m3 IS NOT NULL
        AND o.observed_at > NOW() - INTERVAL '7 days'
    )
    SELECT
      (SELECT COUNT(*)::int FROM obs_daily)                                   AS total,
      (SELECT COUNT(*)::int FROM od_old)                                      AS older_than_60d,
      (SELECT MIN(day)::text FROM obs_daily)                                  AS min_day,
      (SELECT MAX(day)::text FROM obs_daily)                                  AS max_day,
      (SELECT COUNT(*)::int FROM doy)                                         AS dams_with_doy_history,
      (SELECT COUNT(*)::int FROM fresh)                                       AS dams_with_fresh_obs,
      (SELECT COUNT(*)::int FROM doy JOIN fresh USING (dam_id))               AS dams_with_both,
      (SELECT COALESCE(json_agg(d.slug ORDER BY d.slug), '[]'::json)
         FROM doy JOIN fresh USING (dam_id) JOIN dams d ON d.id = doy.dam_id) AS both_slugs
  `.catch((e: unknown) => [{ error: (e as Error).message }] as never);

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
      obs_daily_health: obsDaily[0] ?? null,
      data_realness: {
        only_synthetic_seen: synthSeen && !realSeen,
        any_real_observation_in_30d: realSeen,
      },
      _links: {
        self: { href: '/api/v1/admin/jobs' },
        self_post: { href: '/api/v1/admin/jobs', method: 'POST' },
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

// ---------------------------------------------------------------------------
// POST — enqueue a one-shot graphile-worker job
// ---------------------------------------------------------------------------

const ALLOWED_TASKS = new Set([
  'match:kasenbosai',
  'master:refresh:ndi',
  'master:refresh:damnet',
  'master:match',
  'quality:freshness-check',
  'quality:recompute',
  'storageRate:recompute',
  'aggregates:refresh',
  'backfill:kagoshima-bodik',
  'backfill:mudam',
]);

interface TriggerBody {
  task: string;
  payload?: Record<string, JSONValue>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured' }, { status: 503 });
  }

  const auth = req.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: TriggerBody;
  try {
    body = (await req.json()) as TriggerBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { task, payload = {} } = body;
  if (typeof task !== 'string' || !ALLOWED_TASKS.has(task)) {
    return NextResponse.json(
      { error: `Unknown task "${task}". Allowed: ${[...ALLOWED_TASKS].join(', ')}` },
      { status: 400 },
    );
  }

  // add_job returns a graphile_worker.jobs composite; select .id out of it.
  // The payload param is typed `json`, but sql.json() binds as jsonb, so cast
  // explicitly or PostgreSQL can't resolve the overload.
  let rows: { job_id: string | null }[];
  try {
    rows = await sql<{ job_id: string | null }[]>`
      SELECT (graphile_worker.add_job(
        ${task}::text,
        ${sql.json(payload)}::json,
        max_attempts := 3
      )).id::TEXT AS job_id
    `;
  } catch (e) {
    return NextResponse.json(
      { error: `Failed to enqueue: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      enqueued: true,
      task,
      job_id: rows[0]?.job_id ?? null,
      _links: { self: { href: '/api/v1/admin/jobs', method: 'POST' } },
    },
    { status: 202 },
  );
}
