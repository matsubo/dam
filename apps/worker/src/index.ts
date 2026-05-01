// apps/worker/src/index.ts
import { run } from 'graphile-worker';
import { CRONTAB } from './crontab.ts';
import match from './tasks/master_match.ts';
import refreshDamnet from './tasks/master_refresh_damnet.ts';
import refreshNdi from './tasks/master_refresh_ndi.ts';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const runner = await run({
    connectionString: url,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? '4'),
    noHandleSignals: false,
    pollInterval: 5_000,
    crontab: CRONTAB,
    taskList: {
      'master:refresh:ndi': refreshNdi,
      'master:refresh:damnet': refreshDamnet,
      'master:match': match,
    },
  });

  await runner.promise;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
