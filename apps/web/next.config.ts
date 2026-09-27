import type { NextConfig } from 'next';
import { CACHE_HEADER_ROUTES } from './lib/cache-control.ts';

const nextConfig: NextConfig = {
  // typedRoutes is incompatible with our dynamic-cursor pagination links;
  // routes are validated end-to-end by the Playwright suite instead.
  serverExternalPackages: ['postgres'],
  // Allow LAN hostnames during dev so Next doesn't gate _next/* HMR + RSC fetches
  // as cross-origin (which surfaces as a console warning in the browser).
  allowedDevOrigins: ['mini', 'mini.local', 'mini.saga-lionfish.ts.net', '127.0.0.1'],
  // Cache-Control for public pages; the policy lives in lib/cache-control.ts.
  // middleware.ts sets it too, but Next.js's framework default for
  // `dynamic = 'force-dynamic'` pages (private/no-store/no-cache) is applied
  // AFTER middleware, whereas headers() runs in the routing layer and wins.
  async headers() {
    return CACHE_HEADER_ROUTES.map(({ source, value }) => ({
      source,
      headers: [{ key: 'Cache-Control', value }],
    }));
  },
  images: {
    // Wikimedia is the only permitted photo host. ダム便覧 was removed
    // 2026-09-10: its /media-policy/ grants no blanket reuse and photo
    // copyright rests with individual contributors. Leaving the host out
    // means a stale image_url fails closed instead of hotlinking them.
    remotePatterns: [
      // Wikipedia / Wikimedia Commons thumbnails. Both the thumb path
      // (`/thumb/...`) and the original path land under upload.wikimedia.org.
      { protocol: 'https', hostname: 'upload.wikimedia.org', pathname: '/wikipedia/**' },
    ],
  },
};

export default nextConfig;
