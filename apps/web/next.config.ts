import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // typedRoutes is incompatible with our dynamic-cursor pagination links;
  // routes are validated end-to-end by the Playwright suite instead.
  serverExternalPackages: ['postgres'],
  // Allow LAN hostnames during dev so Next doesn't gate _next/* HMR + RSC fetches
  // as cross-origin (which surfaces as a console warning in the browser).
  allowedDevOrigins: ['mini', 'mini.local', 'mini.saga-lionfish.ts.net', '127.0.0.1'],
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
