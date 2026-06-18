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
 * Execute the same UPDATE that step 1 of storage_rate_recompute.ts runs
 * (recent window).  Returns the count of rows affected.
 */
async function runRecomputeRecent(tx: typeof sql): Promise<number> {
  const result = await tx`
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
  return result.count;
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
  'sr-recompute-test-no-capacity',
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

  await sql.end();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('storageRate:recompute task', () => {
  // storageRate:recompute fills NULL storage_rate values by computing
  // volume / capacity for each observation, clamped to 1.0. Observations
  // that already have a rate are left untouched, and dams without
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

  test('fills storage_rate from volume / capacity for recent NULL-rate observations', async () => {
    if (!dbAvailable) return;

    const capacity = 5_000_000;
    const volume = 3_500_000;
    const expectedRate = volume / capacity; // 0.7

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-fills-recent',
      name: 'SR Recompute Test — Fills Recent',
      activeCapacityM3: capacity,
    });

    const observedAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: volume,
      storageRate: null, // must be filled
    });

    const affectedBefore = await fetchStorageRate(sql, damId, observedAt);
    expect(affectedBefore).toBeNull();

    await runRecomputeRecent(sql);

    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).not.toBeNull();
    expect(rate as number).toBeCloseTo(expectedRate, 5);
  });

  test('clamps storage_rate to 1.0 when volume exceeds capacity', async () => {
    if (!dbAvailable) return;

    const capacity = 4_000_000;
    const volume = 5_000_000; // over-full — rate would be 1.25 without clamping

    const damId = await insertTestDam(sql, {
      slug: 'sr-recompute-test-clamp',
      name: 'SR Recompute Test — Clamp',
      activeCapacityM3: capacity,
    });

    const observedAt = new Date(Date.now() - 45 * 60 * 1000); // 45 min ago
    await insertObservation(sql, {
      damId,
      observedAt,
      storageVolumeM3: volume,
      storageRate: null,
    });

    await runRecomputeRecent(sql);

    const rate = await fetchStorageRate(sql, damId, observedAt);
    expect(rate).not.toBeNull();
    // LEAST(1, 5M / 4M) = LEAST(1, 1.25) = 1.0
    expect(rate as number).toBeCloseTo(1.0, 5);
    expect(rate as number).toBeLessThanOrEqual(1.0);
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
