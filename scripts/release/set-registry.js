#!/usr/bin/env node
/**
 * Resolve the @projexlight registry for an environment (P16 · EP-387).
 *
 * Prints the env assignment a shell or CI job should export. It deliberately does NOT
 * rewrite .npmrc: a release that mutates a tracked file leaves the working tree dirty and
 * makes the next developer's `pnpm install` silently point at production.
 *
 *   node scripts/release/set-registry.js dev     -> http://localhost:4873/
 *   node scripts/release/set-registry.js prod    -> https://npm.projexcloud.com/
 *   eval "$(node scripts/release/set-registry.js prod --export)"
 */
const REGISTRIES = {
  dev: process.env.PROJEXLIGHT_DEV_REGISTRY || 'http://localhost:4873/',
  prod: process.env.PROJEXLIGHT_PROD_REGISTRY || 'https://npm.projexcloud.com/',
};

const env = (process.argv[2] || 'dev').toLowerCase();
const registry = REGISTRIES[env];

if (!registry) {
  console.error(`unknown environment '${env}' — expected one of: ${Object.keys(REGISTRIES).join(', ')}`);
  process.exit(1);
}

if (process.argv.includes('--export')) {
  // The npm_config_ form beats .npmrc for this process only, which is exactly the scope a
  // release job wants: nothing it does leaks into the developer's checkout.
  process.stdout.write(`export npm_config_@projexlight:registry=${registry}\n`);
} else {
  process.stdout.write(`${registry}\n`);
}
