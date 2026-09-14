import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import type { NextRequest } from 'next/server';

process.env.ADMIN_SECRET = 'test-admin-secret';
const SECRET = 'test-admin-secret';

const { GET, POST } = await import('./route.ts');

function post(body: unknown, auth = `Bearer ${SECRET}`): NextRequest {
  return new Request('http://localhost/api/v1/admin/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

async function clearJobs(task: string): Promise<void> {
  // graphile_worker.jobs is a view; delete against the private table, joining
  // the task identifier through _private_tasks.
  await sql`
    DELETE FROM graphile_worker._private_jobs j
    USING graphile_worker._private_tasks t
    WHERE j.task_id = t.id AND t.identifier = ${task}
  `;
}

beforeEach(async () => {
  await clearJobs('aggregates:refresh');
});

afterAll(async () => {
  await clearJobs('aggregates:refresh');
});

describe('POST /api/v1/admin/jobs', () => {
  test('enqueues an allowed task and returns its job id', async () => {
    const res = await POST(post({ task: 'aggregates:refresh' }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.enqueued).toBe(true);
    expect(body.task).toBe('aggregates:refresh');
    expect(body.job_id).toBeTruthy();

    // The job must actually be in the queue.
    const rows = await sql<{ n: bigint }[]>`
      SELECT COUNT(*)::BIGINT AS n FROM graphile_worker.jobs
      WHERE task_identifier = 'aggregates:refresh'
    `;
    expect(Number(rows[0]?.n ?? 0n)).toBe(1);
  });

  test('rejects an unknown task with 400', async () => {
    const res = await POST(post({ task: 'not:a:task' }));
    expect(res.status).toBe(400);
  });

  test('rejects a bad bearer token with 401', async () => {
    const res = await POST(post({ task: 'aggregates:refresh' }, 'Bearer wrong'));
    expect(res.status).toBe(401);
  });
});

describe('GET /api/v1/admin/jobs — failing_jobs (#31)', () => {
  test('surfaces a retries-exhausted job that active_or_pending_jobs would hide', async () => {
    // #31 burned through 25 attempts of storageRate:recompute with the only
    // evidence in the Coolify log: `active_or_pending_jobs` is
    // ORDER BY run_at LIMIT 20, so a job backing off into the future sorts off
    // the end of it. failing_jobs is keyed on the error, not the schedule.
    await POST(post({ task: 'aggregates:refresh' }));
    await sql`
      UPDATE graphile_worker._private_jobs j
      SET attempts = j.max_attempts,
          last_error = 'tuple decompression limit exceeded by operation',
          run_at = NOW() + INTERVAL '10 years'
      FROM graphile_worker._private_tasks t
      WHERE j.task_id = t.id AND t.identifier = 'aggregates:refresh'
    `;

    const body = await (await GET()).json();

    const failing = body.failing_jobs as {
      task: string;
      attempts: number;
      max_attempts: number;
      last_error: string | null;
      exhausted: boolean;
    }[];
    const entry = failing.find((j) => j.task === 'aggregates:refresh');

    expect(entry).toBeDefined();
    expect(entry?.exhausted).toBe(true);
    expect(entry?.attempts).toBe(entry?.max_attempts as number);
    expect(entry?.last_error).toContain('decompression limit');
  });

  test('stays empty while nothing has errored', async () => {
    await POST(post({ task: 'aggregates:refresh' })); // queued, zero attempts
    const body = await (await GET()).json();
    const failing = body.failing_jobs as { task: string }[];
    expect(failing.some((j) => j.task === 'aggregates:refresh')).toBe(false);
  });
});

describe('GET /api/v1/admin/jobs — job visibility regression', () => {
  test('active_or_pending_jobs actually lists a queued job', async () => {
    // Regression guard: these queries read `task_identifier` from
    // `_private_jobs`, which has no such column, and the `.catch(() => [])`
    // turned that into an empty array on every request. The endpoint looked
    // healthy while reporting nothing at all.
    await POST(post({ task: 'aggregates:refresh' }));

    const body = await (await GET()).json();

    expect(body.degraded).toEqual([]);
    const active = body.active_or_pending_jobs as { task: string }[];
    expect(active.some((j) => j.task === 'aggregates:refresh')).toBe(true);

    const depth = body.queue_depth_by_task as { task: string; pending: number }[];
    const entry = depth.find((d) => d.task === 'aggregates:refresh');
    expect(entry?.pending).toBeGreaterThanOrEqual(1);
  });
});
