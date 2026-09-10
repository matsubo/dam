import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';
import { GET } from './route.ts';

let damId: bigint;
const TEST_SOURCE = 'kasenbosai-test'; // unique source so the test owns its priority
const SECOND_SOURCE = 'kasenbosai-test-2'; // a lower-priority second real source
let savedTopPriority: number | null = null;

beforeAll(async () => {
  // Pin our test source as the highest-priority source so the route's
  // preferredSource() returns it. Save the current top so we can restore.
  const topRow = await sql<{ priority: number }[]>`
    SELECT priority FROM source_priorities WHERE active ORDER BY priority DESC LIMIT 1
  `;
  savedTopPriority = topRow[0]?.priority ?? 100;
  await sql`
    INSERT INTO source_priorities (source_id, priority, description)
    VALUES (${TEST_SOURCE}, ${savedTopPriority + 1}, 'integration test'),
           (${SECOND_SOURCE}, ${savedTopPriority + 2}, 'integration test (second source)')
    ON CONFLICT (source_id) DO UPDATE SET priority = EXCLUDED.priority
  `;

  await sql`DELETE FROM observations WHERE source_id IN (${TEST_SOURCE}, ${SECOND_SOURCE})`;
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
      sourceId: TEST_SOURCE,
      storageVolumeM3: 1_000_000,
      storageRate: 0.5,
    },
    // A second real source an hour later — used by the all_sources=1 test
    // below, where both sources must come through instead of just the
    // highest-priority one.
    {
      observedAt: new Date('2026-04-30T11:00:00Z'),
      damId,
      sourceId: SECOND_SOURCE,
      storageVolumeM3: 1_100_000,
      storageRate: 0.55,
    },
  ]);
});

afterAll(async () => {
  if (damId !== undefined) {
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`DELETE FROM dams WHERE id = ${damId}`;
  }
  await sql`DELETE FROM source_priorities WHERE source_id IN (${TEST_SOURCE}, ${SECOND_SOURCE})`;
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

  test('all_sources=1 bypasses preferredSource and returns every source', async () => {
    // By default the route narrows to the single highest-priority source
    // that has rows for this dam, so the chart shows one coherent series.
    // SECOND_SOURCE outranks TEST_SOURCE, so only its row comes through.
    const baseQs = '?from=2026-04-30T00:00:00Z&to=2026-05-01T00:00:00Z&interval=hourly';
    const defaultRes = await GET(makeReq('api-obs-1', baseQs), {
      params: Promise.resolve({ slug: 'api-obs-1' }),
    });
    const defaultBody = await defaultRes.json();
    expect(defaultBody.series.length).toBe(1);
    expect(defaultBody.series[0].sourceId).toBe(SECOND_SOURCE);
    expect(defaultBody.source).toBe(SECOND_SOURCE);

    // all_sources=1 skips preferredSource() entirely, so both rows surface.
    const all = await GET(makeReq('api-obs-1', `${baseQs}&all_sources=1`), {
      params: Promise.resolve({ slug: 'api-obs-1' }),
    });
    expect(all.status).toBe(200);
    const body = await all.json();
    expect(body.series.length).toBe(2);
    expect(body.series.map((p: { sourceId: string }) => p.sourceId).sort()).toEqual(
      [TEST_SOURCE, SECOND_SOURCE].sort(),
    );
    expect(body.source).toBeNull();
  });
});
