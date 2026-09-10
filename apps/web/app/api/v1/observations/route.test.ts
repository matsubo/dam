import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from '@dam/db/client';
import { upsertDamByExternalId } from '@dam/db/repo/dams';
import { upsertObservations } from '@dam/db/repo/observations';

process.env.API_AUTH_BYPASS = '1';
const { GET } = await import('./route.ts');

// Far-future window so the cross-dam feed can't pick up other fixtures or
// real data that happens to live in this database.
const FROM = '2099-02-01T00:00:00Z';
const TO = '2099-02-02T00:00:00Z';
const EXT_IDS = ['API-OBSFEED-1', 'API-OBSFEED-2'];

let damA: bigint;
let damB: bigint;

function at(hour: number): Date {
  return new Date(Date.UTC(2099, 1, 1, hour));
}

function req(qs: string): Request {
  return new Request(`http://localhost/api/v1/observations${qs}`);
}

beforeAll(async () => {
  await sql`DELETE FROM dams WHERE external_ids ->> 'ndi' IN ${sql(EXT_IDS)}`;
  damA = await upsertDamByExternalId('ndi', {
    slug: 'api-obsfeed-1',
    name: 'Feed A',
    prefCode: '13',
    lat: 35.7,
    lng: 139.5,
    externalIds: { ndi: 'API-OBSFEED-1' },
  });
  damB = await upsertDamByExternalId('ndi', {
    slug: 'api-obsfeed-2',
    name: 'Feed B',
    prefCode: '13',
    lat: 35.8,
    lng: 139.6,
    externalIds: { ndi: 'API-OBSFEED-2' },
  });
  await upsertObservations([
    ...[0, 1, 2].flatMap((h) => [
      {
        observedAt: at(h),
        damId: damA,
        sourceId: 'kasenbosai',
        storageVolumeM3: 1_000 + h,
        storageRate: 0.5,
      },
      { observedAt: at(h), damId: damB, sourceId: 'kasenbosai', storageVolumeM3: 2_000 + h },
    ]),
    { observedAt: at(1), damId: damA, sourceId: 'synthetic', storageVolumeM3: 9_999 },
  ]);
});

afterAll(async () => {
  for (const id of [damA, damB]) {
    if (id !== undefined) {
      await sql`DELETE FROM observations WHERE dam_id = ${id}`;
      await sql`DELETE FROM dams WHERE id = ${id}`;
    }
  }
});

describe('GET /api/v1/observations', () => {
  test('200 returns measured rows with dam identity and HAL links', async () => {
    const res = await GET(req(`?from=${FROM}&to=${TO}`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/hal+json');

    const body = await res.json();
    expect(body.count).toBe(6);
    expect(body.items.length).toBe(6);

    const first = body.items[0];
    expect(first.damSlug).toBe('api-obsfeed-1');
    expect(first.damName).toBe('Feed A');
    expect(first.damId).toBe(damA.toString()); // bigint serialised as a string
    expect(first.sourceId).toBe('kasenbosai');
    expect(first.storageVolumeM3).toBe('1000.00');
    expect(first.qualityFlag).toBe(0);
    // Every item links back to its dam rather than making the client build a URL.
    expect(first._links.dam.href).toBe('/api/v1/dams/api-obsfeed-1');
    expect(first._links.observations.href).toContain('/api/v1/dams/api-obsfeed-1/observations');

    expect(body._links.self.href).toContain('/api/v1/observations');
    expect(body._links.next).toBeUndefined();
    expect(res.headers.get('link')).toBeNull();
  });

  test('pages with pageSize + cursor and stops without a next link', async () => {
    const seen: string[] = [];
    let href = `/api/v1/observations?from=${FROM}&to=${TO}&pageSize=2`;
    let pages = 0;

    for (;;) {
      const res = await GET(new Request(`http://localhost${href}`));
      expect(res.status).toBe(200);
      const body = await res.json();
      pages += 1;
      for (const item of body.items) {
        seen.push(`${item.observedAt}|${item.damSlug}|${item.sourceId}`);
      }
      if (!body._links.next) {
        expect(res.headers.get('link')).toBeNull();
        break;
      }
      // The RFC 5988 Link header must agree with the HAL next link.
      expect(res.headers.get('link')).toBe(`<${body._links.next.href}>; rel="next"`);
      href = body._links.next.href;
      if (pages > 10) throw new Error('pagination did not terminate');
    }

    expect(pages).toBe(3);
    expect(seen.length).toBe(6);
    expect(new Set(seen).size).toBe(6);
    // Following `next` preserves the original filters.
    expect(href).toContain('pageSize=2');
  });

  test('never returns synthetic rows, even when asked for them', async () => {
    const measured = await (await GET(req(`?from=${FROM}&to=${TO}`))).json();
    expect(measured.items.some((i: { sourceId: string }) => i.sourceId === 'synthetic')).toBe(
      false,
    );

    // The old opt-in is gone: an unknown query param is ignored, not honoured.
    const asked = await (await GET(req(`?from=${FROM}&to=${TO}&include_synthetic=1`))).json();
    expect(asked.count).toBe(6);
    expect(asked.items.some((i: { sourceId: string }) => i.sourceId === 'synthetic')).toBe(false);
  });

  test('400 on missing, malformed or out-of-range parameters', async () => {
    expect((await GET(req(''))).status).toBe(400);
    expect((await GET(req(`?from=${FROM}`))).status).toBe(400);
    expect((await GET(req(`?from=nonsense&to=${TO}`))).status).toBe(400);
    expect((await GET(req(`?from=${FROM}&to=${TO}&pageSize=0`))).status).toBe(400);
    expect((await GET(req(`?from=${FROM}&to=${TO}&pageSize=5000`))).status).toBe(400);
    // `to` before `from` is a client bug, not an empty result.
    expect((await GET(req(`?from=${TO}&to=${FROM}`))).status).toBe(400);
  });

  test('400 on a cursor we did not mint', async () => {
    const res = await GET(req(`?from=${FROM}&to=${TO}&cursor=%%%not-a-cursor`));
    expect(res.status).toBe(400);
  });

  test('401 without an API key', async () => {
    process.env.API_AUTH_BYPASS = '0';
    try {
      const res = await GET(req(`?from=${FROM}&to=${TO}`));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('Bearer');
    } finally {
      process.env.API_AUTH_BYPASS = '1';
    }
  });
});
