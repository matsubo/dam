import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

// Sweeper for rows whose adapter reported a volume but no rate and where the
// 0036 BEFORE INSERT trigger did not run (or ran before the dam had a master
// capacity). derived_storage_rate() is the same definition the trigger uses —
// migration 0047 — so a row gets the same value whichever writer reaches it
// first, and neither invents one for a volume above 1.5x the capacity.

const task: Task = async (_payload, helpers) => {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL timescaledb.enable_decompression_safety_checks = off`;

    // Step 1: Fill storage_rate for observations in the last 72 hours.
    // Targets uncompressed chunks for fast execution.
    const recent = await tx`
      UPDATE observations o
      SET storage_rate = derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3)
      FROM dams d
      WHERE o.dam_id = d.id
        AND o.storage_rate IS NULL
        AND o.storage_volume_m3 IS NOT NULL
        AND derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3) IS NOT NULL
        AND o.observed_at > NOW() - INTERVAL '72 hours'
    `;
    helpers.logger.info(`storageRate:recompute filled ${recent.count} rows (last 72h)`);

    // Step 2: Backfill storage_rate for all older rows without a time restriction.
    // Slower but runs to completion for historical data.
    const historical = await tx`
      UPDATE observations o
      SET storage_rate = derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3)
      FROM dams d
      WHERE o.dam_id = d.id
        AND o.storage_rate IS NULL
        AND o.storage_volume_m3 IS NOT NULL
        AND derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3) IS NOT NULL
        AND o.observed_at <= NOW() - INTERVAL '72 hours'
    `;
    helpers.logger.info(
      `storageRate:recompute filled ${historical.count} rows (historical backfill)`,
    );
  });
};

export default task;
