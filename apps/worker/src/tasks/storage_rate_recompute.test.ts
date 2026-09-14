// apps/worker/src/tasks/storage_rate_recompute.test.ts
//
// Integration tests for the storageRate:recompute worker task.
//
// These tests exercise the SQL logic from storage_rate_recompute.ts against a
// real database. They are excluded from the pre-push hook when no local DB is
// available (see .githooks/pre-push). To run locally:
//
//   bun test apps/worker/src/tasks/storage_rate_recompute.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { chunkRanges, fillChunkRange, fillRecent } from './storage_rate_recompute.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Probe the DB once; skip all tests when it is unreachable. */
let dbAvailable = false;

/** Insert one dam and return its id. The dam is cleaned up in afterAll. */
async function insertTestDam(
  tx: typeof sql,
  opts: {
    slug: string;
    name: string;
    activeCapacityM3: number | null;
  },
): Promise<bigint> {
  const rows = await tx<{ id: bigint }[]>`
    INSERT INTO dams (slug, name, pref_code, location, external_ids)
    VALUES (
      ${opts.slug},
      ${opts.name},
      '13',
      ST_SetSRID(ST_MakePoint(139.5, 35.7), 4326)::geography,
      '{}'::jsonb
    )
    RETURNING id
  `;
  const row = rows[0];
  if (!row) throw new Error(`Failed to insert test dam: ${opts.slug}`);
  const { id } = row;

  if (opts.activeCapacityM3 !== null) {
    await tx`
      UPDATE dams SET active_capacity_m3 = ${opts.activeCapacityM3} WHERE id = ${id}
    `;
  }

  return id;
}

/** Insert one observation row with storage_rate explicitly NULL. */
async function insertObservation(
  tx: typeof sql,
  opts: {
    damId: bigint;
    observedAt: Date;
    storageVolumeM3: number | null;
    storageRate: number | null;
  },
): Promise<void> {
  await tx`
    INSERT INTO observations (dam_id, observed_at, source_id, storage_volume_m3, storage_rate)
    VALUES (
      ${opts.damId},
      ${opts.observedAt},
      'test',
      ${opts.storageVolumeM3},
      ${opts.storageRate}
    )
    ON CONFLICT (dam_id, observed_at, source_id) DO UPDATE
      SET storage_volume_m3 = EXCLUDED.storage_volume_m3,
          storage_rate      = EXCLUDED.storage_rate
  `;
}

/**
 * Step 1 of the task. Calls the shipped implementation rather than a copy of
 * its SQL — an earlier version of this file re-implemented the UPDATE, which
 * meant the tests could not see the transaction structure that caused #31.
 */
async function runRecomputeRecent(tx: typeof sql): Promise<number> {
  return fillRecent(tx);
}

/** Read back storage_rate for a specific observation. */
async function fetchStorageRate(
  tx: typeof sql,
  damId: bigint,
  observedAt: Date,
): Promise<number | null> {
  const rows = await tx<{ storage_rate: string | null }[]>`
    SELECT storage_rate FROM observations
    WHERE dam_id = ${damId} AND observed_at = ${observedAt} AND source_id = 'test'
  `;
  const raw = rows[0]?.storage_rate ?? null;
  return raw === null ? null : Number(raw);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Slugs chosen to be unique and never conflict with real dams.
const SLUGS = [
  'sr-recompute-test-already-set',
  'sr-recompute-test-fills-recent',
  'sr-recompute-test-clamp',
  'sr-recompute-test-over-15x',
  'sr-recompute-test-no-capacity',
  'sr-recompute-test-compressed',
] as const;

beforeAll(async () => {
  try {
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
    return;
  }

  // Clean up any stale data from a previous interrupted run.
  for (const slug of SLUGS) {
    const rows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${slug}`;
    for (const row of rows) {
      await sql`DELETE FROM observations WHERE dam_id = ${row.id}`;
      await sql`DELETE FROM dams WHERE id = ${row.id}`;
    }
  }
});

afterAll(async () => {
  if (!dbAvailable) return;

  for (const slug of SLUGS) {
    const rows = await sql<{ id: bigint }[]>`SELECT id FROM dams WHERE slug = ${slug}`;
    for (const row of rows) {
      await sql`DELETE FROM observations WHERE dam_id = ${row.id}`;
      await sql`DELETE FROM dams WHERE id = ${row.id}`;
    }
  }
  // Do NOT sql.end() here: the client is shared module state and later test
  // files in the same `bun test` process still need it.
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('storageRate:recompute task', () => {
  // storageRate:recompute fills NULL storage_rate values through
  // derived_storage_rate() — volume / capacity, with no value derived above
  // 1.5, the same definition the 0036 trigger uses (migration 0047).
  // Observations that already have a rate are left untouched, and dams without
  // active_capacity_m3 are skipped entirely.

  test('skips observations that already have storage_rate set', async () => {
    if (!dbAvailable) return;

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-already-set',
      name: 'SR Recompute Test — Already Set',
      activeCapacityM3: 10_000_000,
    });

    const observedAt = new Date(Date.now() - 60 * 60 * 1000); // 1 h ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: 8_000_000,
      storageRate: 0.42, // pre-existing rate — must not be overwritten
    });

    await runRecomputeRecent(sql);

    // The recompute UPDATE only targets rows WHERE storage_rate IS NULL,
    // so this row must not be touched.
    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).toBeCloseTo(0.42, 5);
    expect(rate).not.toBeCloseTo(0.8); // 8M / 10M = 0.8 — wrong if overwritten
  });

  test('fills storage_rate when 利水容量 becomes known after the observation', async () => {
    if (!dbAvailable) return;

    // Since trigger 0036 fills storage_rate inline at INSERT time, the only
    // rows the batch task still needs to fix are those whose dam gained
    // active_capacity_m3 AFTER the observation landed. Seed in that order.
    const capacity = 5_000_000;
    const volume = 3_500_000;
    const expectedRate = volume / capacity; // 0.7

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-fills-recent',
      name: 'SR Recompute Test — Fills Recent',
      activeCapacityM3: null, // capacity not yet known at observation time
    });

    const observedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: volume,
      storageRate: null,
    });

    const affectedBefore = await fetchStorageRate(sql, damId, observedAt);
    expect(affectedBefore).toBeNull();

    await sql`UPDATE dams SET active_capacity_m3 = ${capacity} WHERE id = ${damId}`;
    await runRecomputeRecent(sql);

    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).not.toBeNull();
    expect(rate as number).toBeCloseTo(expectedRate, 5);
  });

  test('keeps a modest over-full rate instead of flattening it to 1.0', async () => {
    if (!dbAvailable) return;

    const capacity = 4_000_000;
    const volume = 5_000_000; // over-full — 1.25

    // Same late-capacity ordering as above so the row reaches the batch task
    // with storage_rate still NULL (trigger 0036 would otherwise fill it).
    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-clamp',
      name: 'SR Recompute Test — Clamp',
      activeCapacityM3: null,
    });

    const observedAt = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: volume,
      storageRate: null,
    });

    await sql`UPDATE dams SET active_capacity_m3 = ${capacity} WHERE id = ${damId}`;
    await runRecomputeRecent(sql);

    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).not.toBeNull();
    // 利水 rates above 100 % are real while the flood pool fills; the read
    // path is what clamps the displayed figure.
    expect(rate as number).toBeCloseTo(1.25, 5);
  });

  test('derives nothing when the volume exceeds 1.5x the capacity', async () => {
    if (!dbAvailable) return;

    // 屈足ダム's shape. A reservoir at 342 % of its recorded 有効貯水容量 is a
    // master-data error, and any rate derived from it is fiction — on a
    // trusted source it used to back-solve into the reported denominator
    // (issue #38 §2-3).
    const capacity = 844_000;
    const volume = 2_883_000;

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-over-15x',
      name: 'SR Recompute Test — Over 1.5x',
      activeCapacityM3: null,
    });

    const observedAt = new Date(Date.now() - 40 * 60 * 1000);
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: volume,
      storageRate: null,
    });

    await sql`UPDATE dams SET active_capacity_m3 = ${capacity} WHERE id = ${damId}`;
    await runRecomputeRecent(sql);

    expect(await fetchStorageRate(sql, damId, observedAt)).toBeNull();
  });

  // ── issue #31: the decompression limit ────────────────────────────────────

  test('chunkRanges separates compressed from uncompressed chunks', async () => {
    if (!dbAvailable) return;

    const uncompressed = await chunkRanges(sql, { compressed: false });
    const compressed = await chunkRanges(sql, { compressed: true });

    // Same chunk must never appear in both lists.
    const compressedStarts = new Set(compressed.map((c) => c.rangeStart.toISOString()));
    for (const c of uncompressed) {
      expect(compressedStarts.has(c.rangeStart.toISOString())).toBe(false);
    }
    // Ranges must be half-open and non-empty, since fillChunkRange bounds on them.
    for (const c of [...uncompressed, ...compressed]) {
      expect(c.rangeEnd.getTime()).toBeGreaterThan(c.rangeStart.getTime());
    }
  });

  test('the daily sweep leaves compressed chunks alone instead of failing', async () => {
    if (!dbAvailable) return;

    // Reproduces #31: an observation old enough to sit in a compressed chunk.
    // The task used to UPDATE all history in one transaction, hit
    // `tuple decompression limit exceeded`, and roll back the recent fill too.
    const capacity = 2_000_000;
    const volume = 1_000_000;

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-compressed',
      name: 'SR Recompute Test — Compressed Chunk',
      activeCapacityM3: null,
    });

    // 120 days back: past the 30-day compression policy from
    // 0014_observation_indexes.sql, so this lands in a compressed chunk.
    const oldObservedAt = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await insertObservation(sql, {
      damId,
      observedAt: oldObservedAt,
      storageVolumeM3: volume,
      storageRate: null,
    });
    await sql`UPDATE dams SET active_capacity_m3 = ${capacity} WHERE id = ${damId}`;

    // Assert the premise rather than skipping on it: if this row is not in a
    // compressed chunk the test proves nothing, and we want to know that.
    const [owning] = await sql<{ is_compressed: boolean }[]>`
      SELECT c.is_compressed
      FROM timescaledb_information.chunks c
      WHERE c.hypertable_name = 'observations'
        AND ${oldObservedAt} >= c.range_start
        AND ${oldObservedAt} <  c.range_end
    `;
    expect(owning).toBeDefined();
    expect(owning?.is_compressed).toBe(true);

    // The uncompressed sweep must not cover this row...
    const uncompressed = await chunkRanges(sql, { compressed: false });
    const covered = uncompressed.some(
      (r) => oldObservedAt >= r.rangeStart && oldObservedAt < r.rangeEnd,
    );
    expect(covered).toBe(false);

    // ...and running the entire uncompressed sweep must not throw.
    for (const range of uncompressed) {
      await sql.begin((tx) => fillChunkRange(tx, range));
    }

    // Still NULL: reaching it is the opt-in pass's job, not the daily one.
    expect(await fetchStorageRate(sql, damId, oldObservedAt)).toBeNull();

    // The opt-in pass does reach it, with the per-transaction cap lifted.
    const compressed = await chunkRanges(sql, { compressed: true });
    for (const range of compressed) {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0`;
        return fillChunkRange(tx, range);
      });
    }
    expect(await fetchStorageRate(sql, damId, oldObservedAt)).toBeCloseTo(0.5, 5);
  });

  test('skips dams without active_capacity_m3', async () => {
    if (!dbAvailable) return;

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-no-capacity',
      name: 'SR Recompute Test — No Capacity',
      activeCapacityM3: null, // no capacity → task must skip
    });

    const observedAt = new Date(Date.now() - 20 * 60 * 1000); // 20 min ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: 1_000_000,
      storageRate: null,
    });

    await runRecomputeRecent(sql);

    // storage_rate must remain NULL because there is no denominator.
    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).toBeNull();
  });
});
