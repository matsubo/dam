import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

const task: Task = async (_payload, helpers) => {
  // 1. Mark observations whose storage_volume is missing (over the last 24h)
  //    with the Missing bit (1).
  const missing = await sql`
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
  const mismatch = await sql`
    UPDATE observations o
    SET quality_flag = quality_flag | 8
    FROM (
      SELECT a.dam_id, a.observed_at
      FROM observations a
      JOIN observations b USING (dam_id, observed_at)
      WHERE a.source_id < b.source_id
        AND a.storage_volume_m3 IS NOT NULL
        AND b.storage_volume_m3 IS NOT NULL
        AND abs(a.storage_volume_m3 - b.storage_volume_m3) /
            GREATEST(a.storage_volume_m3, 1) > 0.05
        AND a.observed_at > NOW() - INTERVAL '24 hours'
    ) x
    WHERE o.dam_id = x.dam_id AND o.observed_at = x.observed_at
      AND (o.quality_flag & 8) = 0
  `;
  helpers.logger.info(`quality:recompute marked ${mismatch.count} rows mismatched`);
};

export default task;
