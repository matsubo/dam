// apps/worker/src/index.ts

import { CRONTAB } from '@dam/core/crontab';
import { run } from 'graphile-worker';
import { TASK_LIST } from './task_list.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const runner = await run({
    connectionString: url,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? '4'),
    noHandleSignals: false,
    pollInterval: 5_000,
    crontab: CRONTAB,
    taskList: TASK_LIST,
  });

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
