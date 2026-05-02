import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import { findNearestWatershed, findWatershedContaining, upsertWatershed } from './watersheds.ts';

const SQUARE_TOKYO = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [139.0, 35.0],
        [140.0, 35.0],
        [140.0, 36.0],
        [139.0, 36.0],
        [139.0, 35.0],
      ],
    ],
  ],
};

describe('watersheds repo', () => {
  beforeAll(async () => {
    await sql`DELETE FROM watersheds WHERE code IN ('TEST-01','TEST-02')`;
    await upsertWatershed({
      code: 'TEST-01',
      slug: 'test-tokyo',
      name: 'Test Tokyo',
      kind: 'first',
      boundaryGeoJSON: SQUARE_TOKYO,
      areaKm2: 100,
    });
  });

  afterAll(async () => {
    await sql`DELETE FROM watersheds WHERE code IN ('TEST-01','TEST-02')`;
  });

  test('findWatershedContaining returns the polygon', async () => {
    const w = await findWatershedContaining(35.5, 139.5);
    expect(w?.code).toBe('TEST-01');
  });

  test('findWatershedContaining returns null outside polygon', async () => {
    const w = await findWatershedContaining(0, 0);
    expect(w).toBeNull();
  });

  test('findNearestWatershed surfaces nearest polygon', async () => {
    // Use a point well inside TEST-01's bbox so it is unambiguously closest
    // even when the DB also has real watersheds loaded around Tokyo.
    const w = await findNearestWatershed(35.5, 139.5);
    expect(w?.code).toBe('TEST-01');
    expect(w?.distanceM).toBeGreaterThanOrEqual(0);
  });
});
