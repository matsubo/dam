import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // typedRoutes is incompatible with our dynamic-cursor pagination links;
  // routes are validated end-to-end by the Playwright suite instead.
  serverExternalPackages: ['postgres'],
  // Allow LAN hostnames during dev so Next doesn't gate _next/* HMR + RSC fetches
  // as cross-origin (which surfaces as a console warning in the browser).
  allowedDevOrigins: ['mini', 'mini.local', 'mini.saga-lionfish.ts.net', '127.0.0.1'],
};

export default nextConfig;
