// apps/worker/src/tasks/ingest_kasenbosai.ts
import { kasenbosaiAdapter } from '@dam/adapters-kasenbosai';
import { runIngestForAdapter } from '@dam/ingest';
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  const r = await runIngestForAdapter(kasenbosaiAdapter, { runAt: new Date() });
  helpers.logger.info(
    `kasenbosai: snapshots=${r.rawSnapshots} obs=${r.observationsWritten} errors=${r.errors}`,
  );
};

export default task;
