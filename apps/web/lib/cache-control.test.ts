import { describe, expect, test } from 'bun:test';
import { CACHE_HEADER_ROUTES, pickCacheControl } from './cache-control.ts';

function sMaxage(value: string): number {
  const m = value.match(/s-maxage=(\d+)/);
  return m ? Number(m[1]) : 0;
}

describe('pickCacheControl', () => {
  test('never lets a shared cache store /account', () => {
    expect(pickCacheControl('/account/keys')).toBe('private, no-store');
  });

  test('browsers always revalidate public pages', () => {
    for (const p of ['/', '/dams/x', '/roadmap', '/legal/terms']) {
      expect(pickCacheControl(p)).toContain('max-age=0,');
    }
  });

  // Deploys purge the CDN, but a missed purge must heal within an hour, not a day.
  test('no public page is held at the edge for more than an hour', () => {
    for (const p of ['/', '/dams', '/roadmap', '/glossary', '/legal/terms', '/sources']) {
      expect(sMaxage(pickCacheControl(p))).toBeLessThanOrEqual(3600);
    }
  });
});

describe('CACHE_HEADER_ROUTES', () => {
  test('agrees with pickCacheControl for every page route it lists', () => {
    for (const { source, value } of CACHE_HEADER_ROUTES) {
      if (source.startsWith('/api/')) continue;
      const sample = source.replace(':path*', 'x').replace(':slug', 'x').replace(':code', '13');
      expect(pickCacheControl(sample)).toBe(value);
    }
  });

  test('keeps the OpenAPI document within an hour at the edge', () => {
    const openapi = CACHE_HEADER_ROUTES.find((r) => r.source === '/api/v1/openapi.json');
    expect(openapi && sMaxage(openapi.value)).toBeLessThanOrEqual(3600);
  });
});
