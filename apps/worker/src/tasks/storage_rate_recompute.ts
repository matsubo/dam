import { sql } from '@dam/db/client';
import type { Task } from 'graphile-worker';
import type postgres from 'postgres';

// Sweeper for rows whose adapter reported a volume but no rate and where the
// 0036 BEFORE INSERT trigger did not run (or ran before the dam had a master
// capacity). derived_storage_rate() is the same definition the trigger uses —
// migration 0047 — so a row gets the same value whichever writer reaches it
// first, and neither invents one for a volume above 1.5x the capacity.
//
// Why this is split into one transaction per chunk (issue #31): the task used
// to run a recent-window UPDATE and an unbounded "everything older" UPDATE in
// a single transaction. `observations` compresses at 30 days
// (0014_observation_indexes.sql), so the second statement reached compressed
// chunks and blew past
// `timescaledb.max_tuples_decompressed_per_dml_transaction` (default 100,000).
// The whole transaction then rolled back — including the recent-window fill —
// so the daily job had been failing outright rather than degrading.
//
// The daily path now touches uncompressed chunks only, one transaction each,
// so a single bad chunk cannot roll back the rest. Rows in compressed chunks
// are left to the opt-in `includeCompressed` pass below.

/**
 * Either the pooled client or a transaction handle, so the helpers below can be
 * called directly with `sql` from a test and with `tx` from inside
 * `sql.begin()` without a cast. The type map is inferred from the client rather
 * than restated, so it cannot drift from `packages/db/src/client.ts`.
 */
type Types = typeof sql extends postgres.Sql<infer T> ? T : never;
type Db = postgres.Sql<Types> | postgres.TransactionSql<Types>;

export type ChunkRange = { rangeStart: Date; rangeEnd: Date };

export type RecomputePayload = {
  /**
   * Also rewrite rows inside compressed chunks. Off by default and NOT set by
   * the daily cron: each chunk has to be decompressed, updated and recompressed,
   * which is expensive and — because historical rows do not change — pointless
   * to repeat nightly. Trigger it by hand after a backfill that added capacity
   * to dams with old observations.
   */
  includeCompressed?: boolean;
};

/**
 * Fill storage_rate for observations in the last 72 hours.
 *
 * Always inside an uncompressed chunk, so this is the cheap, high-value part of
 * the job and runs in its own transaction ahead of everything else.
 */
export async function fillRecent(db: Db): Promise<number> {
  const result = await db`
    UPDATE observations o
    SET storage_rate = derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3)
    FROM dams d
    WHERE o.dam_id = d.id
      AND o.storage_rate IS NULL
      AND o.storage_volume_m3 IS NOT NULL
      AND derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3) IS NOT NULL
      AND o.observed_at > NOW() - INTERVAL '72 hours'
  `;
  return result.count;
}

/**
 * Chunk boundaries of `observations`, filtered by compression state.
 *
 * Compressed and uncompressed chunks interleave — inserting an old row creates
 * a fresh uncompressed chunk in the past — so the ranges are read individually
 * rather than collapsed into one `observed_at > X` bound.
 */
export async function chunkRanges(db: Db, opts: { compressed: boolean }): Promise<ChunkRange[]> {
  const rows = await db<{ range_start: Date; range_end: Date }[]>`
    SELECT range_start, range_end
    FROM timescaledb_information.chunks
    WHERE hypertable_name = 'observations'
      AND is_compressed = ${opts.compressed}
    ORDER BY range_start
  `;
  return rows.map((r) => ({ rangeStart: r.range_start, rangeEnd: r.range_end }));
}

/**
 * Fill storage_rate for one half-open chunk range [rangeStart, rangeEnd).
 *
 * Bounding by the chunk keeps each statement's decompression cost predictable;
 * `NOW() - 72 hours` is excluded because fillRecent already covered it.
 */
export async function fillChunkRange(db: Db, range: ChunkRange): Promise<number> {
  const result = await db`
    UPDATE observations o
    SET storage_rate = derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3)
    FROM dams d
    WHERE o.dam_id = d.id
      AND o.storage_rate IS NULL
      AND o.storage_volume_m3 IS NOT NULL
      AND derived_storage_rate(o.storage_volume_m3, d.active_capacity_m3) IS NOT NULL
      AND o.observed_at >= ${range.rangeStart}
      AND o.observed_at <  ${range.rangeEnd}
      AND o.observed_at <= NOW() - INTERVAL '72 hours'
  `;
  return result.count;
}

const task: Task = async (payload, helpers) => {
  const { includeCompressed = false } = (payload ?? {}) as RecomputePayload;

  // Step 1 — the recent window, on its own so nothing downstream can roll it
  // back. This is the part that matters for what the site serves today.
  const recent = await sql.begin((tx) => fillRecent(tx));
  helpers.logger.info(`storageRate:recompute filled ${recent} rows (last 72h)`);

  // Step 2 — older rows, one transaction per uncompressed chunk. A failure on
  // one chunk is logged and the sweep continues; the next run retries it,
  // because the WHERE clause only ever selects rows still NULL.
  const uncompressed = await chunkRanges(sql, { compressed: false });
  let backfilled = 0;
  let failed = 0;

  for (const range of uncompressed) {
    try {
      backfilled += await sql.begin((tx) => fillChunkRange(tx, range));
    } catch (error) {
      failed += 1;
      helpers.logger.error(
        `storageRate:recompute chunk ${range.rangeStart.toISOString()} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  helpers.logger.info(
    `storageRate:recompute filled ${backfilled} rows across ${uncompressed.length} uncompressed chunks` +
      (failed > 0 ? ` (${failed} chunk(s) failed)` : ''),
  );
  // Each chunk has already committed, so failing here loses nothing — and a
  // task that resolves after every chunk failed is exactly the blind spot #31
  // was: graphile-worker would never retry and `failing_jobs` would never see
  // it.
  if (failed > 0) {
    throw new Error(
      `storageRate:recompute: ${failed}/${uncompressed.length} uncompressed chunks failed`,
    );
  }

  if (!includeCompressed) return;

  // Opt-in: the same sweep over compressed chunks. Decompression is capped per
  // transaction, so the cap is lifted for these single-chunk statements — one
  // chunk is a bounded amount of work, which the old unbounded UPDATE was not.
  const compressed = await chunkRanges(sql, { compressed: true });
  let compressedFilled = 0;
  let compressedFailed = 0;

  for (const range of compressed) {
    try {
      compressedFilled += await sql.begin(async (tx) => {
        await tx`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`;
        return fillChunkRange(tx, range);
      });
    } catch (error) {
      compressedFailed += 1;
      helpers.logger.error(
        `storageRate:recompute compressed chunk ${range.rangeStart.toISOString()} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  helpers.logger.info(
    `storageRate:recompute filled ${compressedFilled} rows across ${compressed.length} compressed chunks` +
      (compressedFailed > 0 ? ` (${compressedFailed} chunk(s) failed)` : ''),
  );
  if (compressedFailed > 0) {
    throw new Error(
      `storageRate:recompute: ${compressedFailed}/${compressed.length} compressed chunks failed`,
    );
  }
};

export default task;
