/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@projexlight/design-system'],
  // Self-contained server bundle for slim Docker images.
  output: 'standalone',
  // Path-based hosting behind nginx (e.g. /tenant). Empty for local dev.
  // Baked in at build time, so set NEXT_PUBLIC_BASE_PATH before `next build`.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  env: {
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3500',
  },
};
module.exports = nextConfig;
