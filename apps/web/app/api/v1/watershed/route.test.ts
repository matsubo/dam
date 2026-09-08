import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertWatershed } from '@dam/db/repo/watersheds';

process.env.API_AUTH_BYPASS = '1';

const { GET } = await import('./route.ts');

const SQUARE = {
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

beforeAll(async () => {
  await upsertWatershed({
    code: 'API-TEST-01',
    slug: 'api-test-tokyo',
    name: 'API Test Tokyo',
    kind: 'first',
    ndiCode: '999901',
    boundaryGeoJSON: SQUARE,
  });
});

afterAll(async () => {
  await sql`DELETE FROM watersheds WHERE code = 'API-TEST-01'`;
});

function makeReq(url: string): Request {
  return new Request(url);
}

describe('GET /api/v1/watershed', () => {
  test('returns 200 with watershed when point is inside', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=35.5&lng=139.5'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.watershed.code).toBe('API-TEST-01');
    expect(body.watershed.ndiCode).toBe('999901');
    expect(body._links.self.href).toContain('lat=35.5');
    expect(body._links.watershed.href).toBe('/api/v1/watersheds/api-test-tokyo');
  });

  test('returns 404 with nearest link when point is outside', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=0&lng=0'));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body._links.nearest?.href).toBeDefined();
  });

  test('returns 400 when params missing', async () => {
    const res = await GET(makeReq('http://localhost/api/v1/watershed?lat=0'));
    expect(res.status).toBe(400);
  });
});
