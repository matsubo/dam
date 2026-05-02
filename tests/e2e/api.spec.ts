import { expect, test } from '@playwright/test';

test('/api/v1/healthz returns hal+json with status ok', async ({ request }) => {
  const r = await request.get('/api/v1/healthz');
  expect(r.status()).toBe(200);
  expect(r.headers()['content-type']).toContain('application/hal+json');
  const body = await r.json();
  expect(body.status).toBe('ok');
  expect(body._links.self.href).toBe('/api/v1/healthz');
});

test('/api/v1/dams returns paginated list with HAL links', async ({ request }) => {
  const r = await request.get('/api/v1/dams?pageSize=3');
  expect(r.status()).toBe(200);
  const body = (await r.json()) as {
    items: { slug: string; name: string; location: { lat: number; lng: number } }[];
    count: number;
    _links: { self: { href: string }; next?: { href: string } };
  };
  expect(body.count).toBeGreaterThan(0);
  expect(body.items[0]?.slug).toBeTruthy();
  expect(body._links.self.href).toContain('/api/v1/dams');
  if (body._links.next) {
    expect(body._links.next.href).toContain('cursor=');
  }
});

test('/api/v1/watershed?lat=&lng= returns 200 inside a polygon', async ({ request }) => {
  // Tokyo coordinates fall inside the 荒川水系 boundary loaded from W07.
  const r = await request.get('/api/v1/watershed?lat=35.681&lng=139.767');
  expect(r.status()).toBe(200);
  const body = (await r.json()) as {
    watershed: { name: string; slug: string; kind: string };
    _links: { watershed: { href: string }; dams_in_watershed: { href: string } };
  };
  expect(body.watershed.name.length).toBeGreaterThan(0);
  expect(body._links.watershed.href).toMatch(/^\/api\/v1\/watersheds\//);
});

test('/api/v1/watershed returns 400 on invalid params', async ({ request }) => {
  const r = await request.get('/api/v1/watershed?lat=foo');
  expect(r.status()).toBe(400);
});

test('/sitemap.xml lists dam URLs', async ({ request }) => {
  const r = await request.get('/sitemap.xml');
  expect(r.status()).toBe(200);
  const text = await r.text();
  expect(text).toContain('<urlset');
  expect(text).toMatch(/<loc>https?:\/\/[^<]+\/dams\/[^<]+<\/loc>/);
});

test('/robots.txt allows everything except /api/', async ({ request }) => {
  const r = await request.get('/robots.txt');
  expect(r.status()).toBe(200);
  const text = await r.text();
  expect(text).toContain('User-Agent: *');
  expect(text).toContain('Disallow: /api/');
});
