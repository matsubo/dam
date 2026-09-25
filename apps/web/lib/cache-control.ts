// The one Cache-Control policy for HTML pages and the OpenAPI document. Read by
// middleware.ts (per request) and next.config.ts headers() (which runs after
// Next's framework defaults and so wins for force-dynamic pages).
//
// Cloudflare caches these responses at the edge for s-maxage. Every deploy
// purges the zone (apps/web/bin/purge_cdn.ts, run as Coolify's post-deployment
// command), so the TTLs only bound how stale a page gets if a purge is missed:
// minutes for data pages, at most an hour for everything else. Browsers always
// revalidate (max-age=0). Hashed /_next/static assets are untouched — Next
// serves them immutable for a year, which is correct.
const CACHE_TIGHT = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
const CACHE_LOOSE = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_PRIVATE = 'private, no-store';

export function pickCacheControl(pathname: string): string {
  if (pathname.startsWith('/account')) return CACHE_PRIVATE;
  if (
    pathname === '/roadmap' ||
    pathname === '/glossary' ||
    pathname.startsWith('/legal/') ||
    pathname === '/sources'
  )
    return CACHE_LOOSE;
  // /, /dams, /watersheds, /map, /stats, /search, dam + watershed details
  return CACHE_TIGHT;
}

const PAGE_ROUTES = [
  '/account/:path*',
  '/roadmap',
  '/glossary',
  '/legal/:path*',
  '/sources',
  '/',
  '/dams',
  '/dams/:slug',
  '/watersheds',
  '/watersheds/:slug',
  '/prefectures/:code',
  '/map',
  '/stats',
  '/search',
];

/** Routes and values for next.config.ts headers(). */
export const CACHE_HEADER_ROUTES: ReadonlyArray<{ source: string; value: string }> = [
  ...PAGE_ROUTES.map((source) => ({
    source,
    value: pickCacheControl(source.replace(/\/:\w+\*?$/, '/x')),
  })),
  // Outside the middleware matcher; force-static, changes only on deploy.
  { source: '/api/v1/openapi.json', value: CACHE_LOOSE },
];
