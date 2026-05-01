// apps/worker/src/tasks/backfill_suimon_enqueue.ts
import { enqueueAllDams } from '@dam/db/repo/backfill_progress';
import type { Task } from 'graphile-worker';

interface Payload {
  fromYear?: number;
  toYear?: number;
}

const task: Task = async (rawPayload, helpers) => {
  const payload = (rawPayload ?? {}) as Payload;
  const fromYear = payload.fromYear ?? 2014;
  const toYear = payload.toYear ?? new Date().getUTCFullYear() - 1;
  const r = await enqueueAllDams('suimon', fromYear, toYear);
  helpers.logger.info(`suimon enqueued ${r} (${fromYear}..${toYear})`);
};

export default task;
