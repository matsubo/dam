import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // typedRoutes is incompatible with our dynamic-cursor pagination links;
  // routes are validated end-to-end by the Playwright suite instead.
  serverExternalPackages: ['postgres'],
  // Allow LAN hostnames during dev so Next doesn't gate _next/* HMR + RSC fetches
  // as cross-origin (which surfaces as a console warning in the browser).
  allowedDevOrigins: ['mini', 'mini.local', 'mini.saga-lionfish.ts.net', '127.0.0.1'],
  // CDN-friendly Cache-Control for public pages. middleware.ts sets these
  // too, but Next.js's framework default for `dynamic = 'force-dynamic'`
  // pages (private/no-store/no-cache) is applied AFTER middleware.
  // headers() runs in the routing layer and overrides framework defaults.
  //
  // s-maxage targets shared caches (CDN); browsers always revalidate
  // (max-age=0). stale-while-revalidate keeps the stale copy serving while
  // the CDN refreshes in the background.
  async headers() {
    const TIGHT =
      'public, max-age=0, s-maxage=300, stale-while-revalidate=86400';
    const LOOSE =
      'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
    const PRIVATE = 'private, no-store';
    return [
      // Account routes — never cache.
      { source: '/account/:path*', headers: [{ key: 'Cache-Control', value: PRIVATE }] },
      // High-stability content — daily refresh is plenty.
      { source: '/roadmap', headers: [{ key: 'Cache-Control', value: LOOSE }] },
      { source: '/glossary', headers: [{ key: 'Cache-Control', value: LOOSE }] },
      { source: '/legal/:path*', headers: [{ key: 'Cache-Control', value: LOOSE }] },
      { source: '/sources', headers: [{ key: 'Cache-Control', value: LOOSE }] },
      // OpenAPI is force-static — long shared cache, browsers revalidate.
      { source: '/api/v1/openapi.json', headers: [{ key: 'Cache-Control', value: LOOSE }] },
      // Public listing + detail pages — 5 min shared, 1 day SWR.
      { source: '/', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/dams', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/dams/:slug', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/watersheds', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/watersheds/:slug', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/prefectures/:code', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/map', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/stats', headers: [{ key: 'Cache-Control', value: TIGHT }] },
      { source: '/search', headers: [{ key: 'Cache-Control', value: TIGHT }] },
    ];
  },
  images: {
    // Cover images are sourced from Damnet's WordPress uploads; allow the
    // host so next/image can optimise them.
    remotePatterns: [
      { protocol: 'https', hostname: 'dambinran.damnet.or.jp', pathname: '/wp-content/uploads/**' },
      // Wikipedia / Wikimedia Commons thumbnails — fallback when Damnet has no
      // photo. Both the thumb path (`/thumb/...`) and the original path land
      // under upload.wikimedia.org.
      { protocol: 'https', hostname: 'upload.wikimedia.org', pathname: '/wikipedia/**' },
    ],
  },
};

export default nextConfig;
