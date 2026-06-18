import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL timescaledb.enable_decompression_safety_checks = off`;

    // Step 1: Fill storage_rate for observations in the last 72 hours.
    // Targets uncompressed chunks for fast execution.
    const recent = await tx`
      UPDATE observations o
      SET storage_rate = LEAST(1, o.storage_volume_m3 / d.active_capacity_m3)
      FROM dams d
      WHERE o.dam_id = d.id
        AND o.storage_rate IS NULL
        AND o.storage_volume_m3 IS NOT NULL
        AND d.active_capacity_m3 IS NOT NULL
        AND d.active_capacity_m3 > 0
        AND o.observed_at > NOW() - INTERVAL '72 hours'
    `;
    helpers.logger.info(`storageRate:recompute filled ${recent.count} rows (last 72h)`);

    // Step 2: Backfill storage_rate for all older rows without a time restriction.
    // Slower but runs to completion for historical data.
    const historical = await tx`
      UPDATE observations o
      SET storage_rate = LEAST(1, o.storage_volume_m3 / d.active_capacity_m3)
      FROM dams d
      WHERE o.dam_id = d.id
        AND o.storage_rate IS NULL
        AND o.storage_volume_m3 IS NOT NULL
        AND d.active_capacity_m3 IS NOT NULL
        AND d.active_capacity_m3 > 0
        AND o.observed_at <= NOW() - INTERVAL '72 hours'
    `;
    helpers.logger.info(
      `storageRate:recompute filled ${historical.count} rows (historical backfill)`,
    );
  });
};

export default task;
