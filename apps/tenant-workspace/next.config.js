const fs = require('node:fs');
const path = require('node:path');

/**
 * Load env vars from the monorepo's root .env file so Next.js dev/build sees
 * shared secrets (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.) without each app
 * needing its own .env.local. The api-gateway already does this via the
 * `dotenv` package; we inline a minimal parser to avoid adding a runtime
 * dep just for next.config.js.
 *
 * Precedence: existing process.env values win (so apps/tenant-workspace/.env.local
 * still overrides). Quiet failure if the root .env is missing.
 */
function loadRootEnv() {
  const candidates = [
    path.resolve(__dirname, '../../.env'), // monorepo root .env
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        if (!key || process.env[key] !== undefined) continue;
        let val = line.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        process.env[key] = val;
      }
    } catch (err) {
      console.warn('[tenant-workspace/next.config.js] failed to load root .env:', err.message);
    }
  }
}
loadRootEnv();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
