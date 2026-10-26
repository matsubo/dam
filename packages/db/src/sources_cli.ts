// Source declarations → database, run by deploy/bootstrap.sh on web pod start.
//
//   bun run --filter @dam/db sources sync   after migrations: write every
//                                           declared source_priorities row
//   bun run --filter @dam/db sources kick   enqueue every active source's
//                                           ingest task now (BOOTSTRAP_KICK)

import { SOURCES } from '@dam/core/sources';
import { sql } from './client.ts';
import { syncSourcePriorities } from './repo/source_priorities.ts';

async function sync(): Promise<void> {
  const { synced, undeclared } = await syncSourcePriorities();
  console.log(`[sources] synced ${synced} declared source rows`);
  if (undeclared.length > 0) {
    console.log(`[sources] rows without a declaration (left as is): ${undeclared.join(', ')}`);
  }
}

async function kick(): Promise<void> {
  // Keyed like their cron line, so the next tick replaces a kick that is
  // still retrying (see packages/core/src/crontab.ts).
  const tasks = SOURCES.flatMap((s) => (s.status === 'active' && s.ingest ? [s.ingest.task] : []));
  for (const task of tasks) {
    await sql`SELECT graphile_worker.add_job(${task}, '{}'::json, job_key := ${task})`;
  }
  console.log(`[sources] enqueued ${tasks.length} ingest tasks`);
}

const command = process.argv[2];
try {
  if (command === 'sync') await sync();
  else if (command === 'kick') await kick();
  else {
    console.error('usage: sources_cli.ts sync|kick');
    process.exitCode = 2;
  }
} finally {
  await sql.end();
}
