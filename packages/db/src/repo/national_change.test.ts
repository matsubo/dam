import { describe, expect, test } from 'bun:test';
import { nationalStorageChange, watershedStorageChange } from './watersheds.ts';
import { sql } from '../client.ts';

// Smoke-only: these aggregate over real seeded data, so we only assert shape
// and basic invariants. The detailed math is covered by storage_change.test
// against a controlled fixture dam.

// nationalStorageChange runs 8 LATERAL joins across the entire observations
// hypertable. With the local 6.7M-row seed it can take 5–15 s the first
// time. Bump the test timeout to 30 s so cold-cache runs don't flake.
const NATIONAL_TIMEOUT = 30_000;

describe('nationalStorageChange', () => {
  test(
    'returns the full shape with eight buckets',
    async () => {
      const c = await nationalStorageChange();
    // shape
    for (const k of ['current', 'h1', 'h6', 'h12', 'd1', 'd7', 'd30', 'd365', 'd1825'] as const) {
      // each bucket field exists, even if null
      expect(k in c).toBe(true);
    }
    // ageS fields exist for each non-current bucket
    for (const k of [
      'h1AgeS',
      'h6AgeS',
      'h12AgeS',
      'd1AgeS',
      'd7AgeS',
      'd30AgeS',
      'd365AgeS',
      'd1825AgeS',
    ] as const) {
      expect(k in c).toBe(true);
    }
    },
    NATIONAL_TIMEOUT,
  );

  test(
    'current is non-null whenever the seeded data has rate-able dams',
    async () => {
      // Skip the assertion if there are no rate-able dams — keeps the test
      // green on a fresh DB before seeding.
      const [{ n }] = await sql<{ n: bigint }[]>`
        SELECT COUNT(*)::BIGINT AS n FROM dams WHERE active_capacity_m3 IS NOT NULL
      `;
      if (Number(n) === 0) return;
      const c = await nationalStorageChange();
      expect(c.current).not.toBeNull();
      expect(Number(c.current)).toBeGreaterThan(0);
    },
    NATIONAL_TIMEOUT,
  );
});

describe('watershedStorageChange', () => {
  test(
    'returns the full shape for a real watershed',
    async () => {
    // Pick an arbitrary watershed that has rate-able dams.
    const [pick] = await sql<{ id: bigint }[]>`
      SELECT w.id
      FROM watersheds w
      JOIN dams d ON d.watershed_id = w.id
      WHERE d.active_capacity_m3 IS NOT NULL
      GROUP BY w.id
      LIMIT 1
    `;
    if (!pick) return; // empty seed — nothing to assert
    const c = await watershedStorageChange(pick.id);
    expect('current' in c).toBe(true);
    expect('h1' in c).toBe(true);
    expect('d1825' in c).toBe(true);
    },
    NATIONAL_TIMEOUT,
  );

  test(
    'returns null shape for a watershed with no rate-able dams',
    async () => {
      // Find one if any. If all watersheds have rate-able dams, skip.
      const [pick] = await sql<{ id: bigint }[]>`
        SELECT w.id FROM watersheds w
        WHERE NOT EXISTS (
          SELECT 1 FROM dams d
          WHERE d.watershed_id = w.id AND d.active_capacity_m3 IS NOT NULL
        )
        LIMIT 1
      `;
      if (!pick) return;
      const c = await watershedStorageChange(pick.id);
      expect(c.current).toBeNull();
      expect(c.d365).toBeNull();
    },
    NATIONAL_TIMEOUT,
  );
});
