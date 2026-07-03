// aggregates:refresh — materialize the TimescaleDB continuous aggregates
// over their FULL history.
//
// The obs_daily refresh policy only covers the trailing 60 days, so bulk
// imports of older data (mudam's 27-year backfill, prefecture archives)
// never reach the aggregate on their own — and 平年比 (seasonal-norm)
// queries read obs_daily. Scheduled monthly after the mudam tail backfill.
// TimescaleDB only recomputes invalidated regions, so runs where nothing
// old changed are cheap.

import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

export async function refreshContinuousAggregates(): Promise<void> {
  // CALL refresh_continuous_aggregate cannot run inside a transaction;
  // sql.unsafe issues a single autocommitted statement.
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_daily', NULL, NULL)`);
  await sql.unsafe(`CALL refresh_continuous_aggregate('obs_monthly', NULL, NULL)`);
}

const task: Task = async (_payload, helpers) => {
  const t0 = Date.now();
  await refreshContinuousAggregates();
  helpers.logger.info(`aggregates:refresh done in ${Math.round((Date.now() - t0) / 1000)}s`);
};

export default task;
