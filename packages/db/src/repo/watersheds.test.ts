import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '../client.ts';
import {
  findNearestWatershed,
  findWatershedBySlug,
  findWatershedContaining,
  listWatersheds,
  upsertWatershed,
} from './watersheds.ts';

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

let testId: bigint;

describe('watersheds repo', () => {
  beforeAll(async () => {
    await sql`DELETE FROM watersheds WHERE code IN ('TEST-01','TEST-02')`;
    testId = await upsertWatershed({
      code: 'TEST-01',
      slug: 'test-tokyo',
      name: 'Test Tokyo',
      kind: 'first',
      ndiCode: '830303',
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

  test('upsertWatershed stores the 水系域コード and reads it back by slug', async () => {
    const w = await findWatershedBySlug('test-tokyo');
    expect(w?.ndiCode).toBe('830303');
  });

  test('findWatershedContaining exposes ndiCode', async () => {
    const w = await findWatershedContaining(35.5, 139.5);
    expect(w?.ndiCode).toBe('830303');
  });

  test('listWatersheds items carry ndiCode', async () => {
    const r = await listWatersheds({ cursor: testId - 1n, pageSize: 1 });
    expect(r.items[0]?.code).toBe('TEST-01');
    expect(r.items[0]?.ndiCode).toBe('830303');
  });

  test('re-upserting the same code replaces ndiCode', async () => {
    await upsertWatershed({
      code: 'TEST-02',
      slug: 'test-two',
      name: 'Test Two',
      kind: 'other',
      ndiCode: null,
      boundaryGeoJSON: SQUARE_TOKYO,
    });
    await upsertWatershed({
      code: 'TEST-02',
      slug: 'test-two',
      name: 'Test Two',
      kind: 'second',
      ndiCode: '020036',
      boundaryGeoJSON: SQUARE_TOKYO,
    });
    const w = await findWatershedBySlug('test-two');
    expect(w).toMatchObject({ kind: 'second', ndiCode: '020036' });
  });

  test('listWatersheds can return the whole master in one page', async () => {
    const counted = await sql<{ total: number }[]>`SELECT count(*)::int AS total FROM watersheds`;
    const r = await listWatersheds({ pageSize: 1000 });
    expect(r.items).toHaveLength(counted[0]?.total ?? -1);
    expect(r.nextCursor).toBeNull();
  });
});
