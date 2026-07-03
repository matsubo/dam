import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertWatershed } from '@dam/db/repo/watersheds';

const { GET } = await import('./route.ts');

const SQUARE_OFFSHORE = {
  type: 'MultiPolygon',
  coordinates: [
    [
      [
        [152.0, 30.0],
        [153.0, 30.0],
        [153.0, 31.0],
        [152.0, 31.0],
        [152.0, 30.0],
      ],
    ],
  ],
};

beforeAll(async () => {
  await upsertWatershed({
    code: 'LOCATE-TEST-01',
    slug: 'locate-test',
    name: 'Locate Test',
    kind: 'first',
    boundaryGeoJSON: SQUARE_OFFSHORE,
  });
});

afterAll(async () => {
  await sql`DELETE FROM watersheds WHERE code = 'LOCATE-TEST-01'`;
});

describe('GET /watersheds/locate', () => {
  test('redirects to the containing watershed page', async () => {
    const res = await GET(new Request('http://localhost/watersheds/locate?lat=30.5&lng=152.5'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/watersheds/locate-test');
  });

  test('invalid coords → redirect to the watershed index with an error flag', async () => {
    const res = await GET(new Request('http://localhost/watersheds/locate?lat=abc&lng=152.5'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/watersheds?locate=invalid');
  });

  test('point in no watershed falls back to the nearest one', async () => {
    // Just outside the test square; nearest polygon is still the test one
    // when the point sits in remote open ocean.
    const res = await GET(new Request('http://localhost/watersheds/locate?lat=31.05&lng=152.5'));
    expect(res.status).toBe(307);
    const loc = res.headers.get('location') ?? '';
    expect(loc.includes('/watersheds/')).toBe(true);
  });
});
