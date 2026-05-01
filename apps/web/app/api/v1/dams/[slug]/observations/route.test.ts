import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { GET } from './route.ts';

let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM observations WHERE source_id = 'kasenbosai' AND dam_id IN (SELECT id FROM dams WHERE external_ids ->> 'ndi' = 'API-OBS-1')`;
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' = 'API-OBS-1'`;
  damId = await upsertDamByExternalId('ndi', {
    slug: 'api-obs-1',
    name: 'API Obs Test',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'API-OBS-1' },
  });
  await upsertObservations([
    {
      observedAt: new Date('2026-04-30T10:00:00Z'),
      damId,
      sourceId: 'kasenbosai',
      storageVolumeM3: 1_000_000,
      storageRate: 0.5,
    },
  ]);
});

afterAll(async () => {
  if (damId !== undefined) {
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`DELETE FROM dams WHERE id = ${damId}`;
  }
});

function makeReq(slug: string, qs: string): Request {
  return new Request(`http://localhost/api/v1/dams/${slug}/observations${qs}`);
}

describe('GET /api/v1/dams/[slug]/observations', () => {
  test('200 returns hourly series', async () => {
    const res = await GET(
      makeReq('api-obs-1', '?from=2026-04-30T00:00:00Z&to=2026-05-01T00:00:00Z&interval=hourly'),
      { params: Promise.resolve({ slug: 'api-obs-1' }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.series.length).toBe(1);
    expect(body._links.self.href).toContain('api-obs-1');
  });

  test('404 on unknown slug', async () => {
    const res = await GET(
      makeReq(
        'does-not-exist',
        '?from=2026-04-30T00:00:00Z&to=2026-05-01T00:00:00Z&interval=hourly',
      ),
      { params: Promise.resolve({ slug: 'does-not-exist' }) },
    );
    expect(res.status).toBe(404);
  });

  test('400 on missing params', async () => {
    const res = await GET(makeReq('api-obs-1', ''), {
      params: Promise.resolve({ slug: 'api-obs-1' }),
    });
    expect(res.status).toBe(400);
  });
});
