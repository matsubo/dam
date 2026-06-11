import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  await sql.begin(async (tx) => {
    // Allow decompression of compressed chunks within this transaction.
    // Only recent (uncompressed) data is targeted, but without this the
    // EXISTS subquery can confuse TimescaleDB's chunk exclusion and
    // exceed the decompression safety limit.
    await tx`SET LOCAL timescaledb.enable_decompression_safety_checks = off`;

    // 1. Mark observations whose storage_volume is missing (over the last 24h)
    //    with the Missing bit (1).
    const missing = await tx`
      UPDATE observations
      SET quality_flag = quality_flag | 1
      WHERE observed_at > NOW() - INTERVAL '24 hours'
        AND storage_volume_m3 IS NULL
        AND (quality_flag & 1) = 0
    `;
    helpers.logger.info(`quality:recompute marked ${missing.count} rows missing`);

    // 2. Cross-source mismatch: same dam × hour with two sources whose
    //    storage_volume_m3 differ by > 5%. Mark all rows for that
    //    (dam_id, observed_at) with the Mismatch bit (8).
    // Use EXISTS to avoid a cross-product self-join that bypasses chunk exclusion.
    const mismatch = await tx`
      UPDATE observations o
      SET quality_flag = quality_flag | 8
      WHERE o.observed_at > NOW() - INTERVAL '24 hours'
        AND o.storage_volume_m3 IS NOT NULL
        AND (o.quality_flag & 8) = 0
        AND EXISTS (
          SELECT 1 FROM observations b
          WHERE b.dam_id = o.dam_id
            AND b.observed_at = o.observed_at
            AND b.source_id <> o.source_id
            AND b.storage_volume_m3 IS NOT NULL
            AND b.observed_at > NOW() - INTERVAL '24 hours'
            AND abs(o.storage_volume_m3 - b.storage_volume_m3) /
                GREATEST(o.storage_volume_m3, 1) > 0.05
        )
    `;
    helpers.logger.info(`quality:recompute marked ${mismatch.count} rows mismatched`);
  });
};

export default task;
