import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';

/**
 * Null out phantom zero-storage readings across ALL sources.
 *
 * Several feeds (kasenbosai, and prefecture 河川防災 sources like
 * ishikawa-kasen / nagano-kasen / miyagi-kasen) publish a literal 0 貯水量 for
 * dams that simply don't measure reservoir volume — they report level + flow
 * only. Stored as 0, trigger 0036 then derives a phantom 0.0%, and the dam
 * lands on the drought list despite passing water.
 *
 * Guard: only (dam, source) pairs whose ENTIRE storage series is zero. A
 * genuinely drawn-down reservoir has non-zero history, so its 0 is preserved.
 * Runs over recent rows only (writes stay small); the all-zero check scans the
 * dam's full history so a single real reading anywhere protects it. Idempotent
 * and self-healing — new placeholder rows from the 10-min feeds are cleaned on
 * the next daily pass. Supersedes the one-shot migrations 0038/0039.
 */
export async function nullPhantomZeroSeries(db: typeof sql): Promise<number> {
  const res = await db`
    UPDATE observations o
    SET storage_volume_m3 = NULL,
        storage_rate      = NULL
    WHERE o.observed_at > NOW() - INTERVAL '48 hours'
      AND o.storage_volume_m3 = 0
      AND (o.dam_id, o.source_id) IN (
        SELECT dam_id, source_id
        FROM observations
        WHERE storage_volume_m3 IS NOT NULL
        GROUP BY dam_id, source_id
        HAVING MAX(storage_volume_m3) = 0
      )
  `;
  return res.count;
}

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

    // 3. Null phantom zero-storage placeholders (all-zero (dam, source)
    //    series) so non-reporting dams don't sit on the drought list at 0.0%.
    const nulled = await nullPhantomZeroSeries(tx as unknown as typeof sql);
    helpers.logger.info(`quality:recompute nulled ${nulled} phantom zero-storage rows`);
  });
};

export default task;
