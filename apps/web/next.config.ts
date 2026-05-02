import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // typedRoutes is incompatible with our dynamic-cursor pagination links;
  // routes are validated end-to-end by the Playwright suite instead.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
