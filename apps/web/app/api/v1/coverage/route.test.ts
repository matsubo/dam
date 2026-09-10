import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { recordUniverse } from '@dam/db/repo/source_universe';

process.env.API_AUTH_BYPASS = '1';
const { GET } = await import('./route.ts');

const SRC = 'coverage-api-test';
const EXT = ['COVAPI-1'];
let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM source_universe WHERE source_id = ${SRC}`;
  await sql`DELETE FROM source_universe_runs WHERE source_id = ${SRC}`;
  await sql`
    DELETE FROM observations WHERE dam_id IN (
      SELECT id FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT)})`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT)}`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'cov-api-1',
    name: 'Coverage API Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'COVAPI-1' },
  });
  await recordUniverse(SRC, [
    { externalId: 'c-1', name: 'Coverage API Test', resolvedDamId: damId },
  ]);
});

afterAll(async () => {
  await sql`DELETE FROM source_universe WHERE source_id = ${SRC}`;
  await sql`DELETE FROM source_universe_runs WHERE source_id = ${SRC}`;
  if (damId !== undefined) {
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`DELETE FROM dams WHERE id = ${damId}`;
  }
});

describe('GET /api/v1/coverage', () => {
  test('returns the summary with the honesty gate exposed', async () => {
    const res = await GET(new Request('http://localhost/api/v1/coverage'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/hal+json');
    const body = await res.json();

    for (const k of ['covered', 'publishedNotIngested', 'unknown', 'notPublished']) {
      expect(typeof body.summary[k]).toBe('number');
    }
    // The gate must be visible to clients: while > 0, `notPublished` is not a
    // claim that nobody publishes those dams — it is "not looked at yet".
    expect(typeof body.summary.sourcesPendingScan).toBe('number');
    expect(body.summary.sourcesPendingScan).toBeGreaterThan(0);
    expect(body._links.self.href).toBe('/api/v1/coverage');
  });

  test('status=published_not_ingested lists the actionable dams with links', async () => {
    const res = await GET(
      new Request('http://localhost/api/v1/coverage?status=published_not_ingested'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const mine = body.items.find((i: { slug: string }) => i.slug === 'cov-api-1');
    expect(mine).toBeDefined();
    expect(mine.status).toBe('published_not_ingested');
    expect(mine.publishedBy).toContain(SRC);
    expect(mine._links.dam.href).toBe('/api/v1/dams/cov-api-1');
  });

  test('400 on an unknown status filter', async () => {
    const res = await GET(new Request('http://localhost/api/v1/coverage?status=nonsense'));
    expect(res.status).toBe(400);
  });

  test('401 without an API key', async () => {
    process.env.API_AUTH_BYPASS = '0';
    try {
      const res = await GET(new Request('http://localhost/api/v1/coverage'));
      expect(res.status).toBe(401);
    } finally {
      process.env.API_AUTH_BYPASS = '1';
    }
  });
});
