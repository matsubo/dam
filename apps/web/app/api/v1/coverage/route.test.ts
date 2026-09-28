import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { recordUniverse } from '@dam/db/repo/source_universe';

process.env.API_AUTH_BYPASS = '1';
const { GET } = await import('./route.ts');

const SRC = 'coverage-api-test';
// An observation source that has never recorded a scan: the fixture's own
// handle on the honesty gate, so the test never depends on rollout progress.
const PENDING = 'coverage-api-pending';
const EXT = ['COVAPI-1'];
let damId: bigint;

beforeAll(async () => {
  await sql`DELETE FROM source_universe WHERE source_id IN (${SRC}, ${PENDING})`;
  await sql`DELETE FROM source_universe_runs WHERE source_id IN (${SRC}, ${PENDING})`;
  await sql`
    INSERT INTO source_priorities (source_id, priority, description, provides_observations)
    VALUES (${PENDING}, 1, 'coverage gate test', TRUE)
    ON CONFLICT (source_id) DO UPDATE SET
      active = TRUE, provides_observations = TRUE,
      universe_enumerable = TRUE, historical_only = FALSE
  `;
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
  await sql`DELETE FROM source_universe WHERE source_id IN (${SRC}, ${PENDING})`;
  await sql`DELETE FROM source_universe_runs WHERE source_id IN (${SRC}, ${PENDING})`;
  await sql`DELETE FROM source_priorities WHERE source_id = ${PENDING}`;
  if (damId !== undefined) {
    await sql`DELETE FROM observations WHERE dam_id = ${damId}`;
    await sql`DELETE FROM dams WHERE id = ${damId}`;
  }
});

async function summary(): Promise<Record<string, unknown>> {
  const res = await GET(new Request('http://localhost/api/v1/coverage'));
  expect(res.status).toBe(200);
  return (await res.json()).summary;
}

describe('GET /api/v1/coverage', () => {
  test('returns the summary with the honesty gate exposed', async () => {
    const res = await GET(new Request('http://localhost/api/v1/coverage'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/hal+json');
    const body = await res.json();

    for (const k of [
      'covered',
      'publishedNotIngested',
      'publishedNoData',
      'unknown',
      'notPublished',
    ]) {
      expect(typeof body.summary[k]).toBe('number');
    }
    // Historical dumps are excluded from the gate, and clients are told how many.
    expect(Number.isInteger(body.summary.sourcesHistoricalOnly)).toBe(true);
    expect(body._links.self.href).toBe('/api/v1/coverage');
  });

  test('sourcesPendingScan counts unrecorded sources and drops to 0 once all record', async () => {
    // Stand in for every other still-unscanned source (on a fresh scratch DB
    // the migration-seeded ones never record), leaving PENDING as the only
    // thing holding the gate open. Only the stamps inserted here are removed.
    const others = await sql<{ source_id: string }[]>`
      SELECT sp.source_id FROM source_priorities sp
      WHERE sp.active AND sp.provides_observations AND sp.universe_enumerable
        AND NOT sp.historical_only AND sp.source_id <> ${PENDING}
        AND NOT EXISTS (SELECT 1 FROM source_universe_runs r WHERE r.source_id = sp.source_id)
    `;
    const stubbed = others.map((r) => r.source_id);
    try {
      for (const id of stubbed) {
        await sql`
          INSERT INTO source_universe_runs (source_id, last_full_scan_at, row_count)
          VALUES (${id}, NOW(), 0)`;
      }

      // While > 0, `notPublished` is not a claim that nobody publishes those
      // dams — it is "not looked at yet". The summary must say so, and name
      // the source holding the gate open so a reader knows what to fix.
      const open = await summary();
      expect(open.sourcesPendingScan).toBe(1);
      expect(open.pendingScanSources).toEqual([
        {
          sourceId: PENDING,
          // No editorial entry for the fixture: the id stands in as its label.
          label: PENDING,
          reason: 'no_recent_observations',
          _links: {
            source: { href: `/api/v1/sources/${PENDING}` },
            web: { href: `/sources/${PENDING}` },
          },
        },
      ]);

      await recordUniverse(PENDING, [
        { externalId: 'p-1', name: 'Coverage gate stub', resolvedDamId: null },
      ]);
      const closed = await summary();
      expect(closed.sourcesPendingScan).toBe(0);
      expect(closed.pendingScanSources).toEqual([]);
    } finally {
      if (stubbed.length > 0) {
        await sql`DELETE FROM source_universe_runs WHERE source_id IN ${sql(stubbed)}`;
      }
    }
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

  test('status=published_no_data lists a dam whose provider publishes no value', async () => {
    await recordUniverse(SRC, [
      { externalId: 'c-1', name: 'Coverage API Test', resolvedDamId: damId, hasData: false },
    ]);
    try {
      const res = await GET(
        new Request('http://localhost/api/v1/coverage?status=published_no_data'),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      const mine = body.items.find((i: { slug: string }) => i.slug === 'cov-api-1');
      expect(mine?.status).toBe('published_no_data');
      expect(mine?.publishedBy).toContain(SRC);
      expect(typeof body.statusMeanings.published_no_data).toBe('string');
    } finally {
      await recordUniverse(SRC, [
        { externalId: 'c-1', name: 'Coverage API Test', resolvedDamId: damId, hasData: true },
      ]);
    }
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
