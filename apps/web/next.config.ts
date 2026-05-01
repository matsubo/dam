import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: { typedRoutes: true },
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
