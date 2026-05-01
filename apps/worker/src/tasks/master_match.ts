// apps/worker/src/tasks/master_match.ts
import type { Task } from 'graphile-worker';

// Stub: in Plan 2/3 we'll add reconciliation re-runs and review processing.
const task: Task = async (_payload, helpers) => {
  helpers.logger.info('master.match: nothing to do (placeholder)');
};

export default task;
