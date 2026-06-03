/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Gateway is the only backend the admin portal talks to. Override with
  // NEXT_PUBLIC_GATEWAY_URL in deploys.
  env: {
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3500',
  },
};
module.exports = nextConfig;
