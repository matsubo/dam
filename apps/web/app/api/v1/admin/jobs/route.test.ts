import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import type { NextRequest } from 'next/server';

process.env.ADMIN_SECRET = 'test-admin-secret';
const SECRET = 'test-admin-secret';

const { POST } = await import('./route.ts');

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
