// apps/worker/src/tasks/quality_recompute.ts
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  // TODO: per-dam-day missing-rate recomputation; cross-source mismatch detection.
  // Placeholder so the cron entry is real.
  helpers.logger.info('quality:recompute: noop placeholder');
};

export default task;
