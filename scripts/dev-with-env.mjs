#!/usr/bin/env node
/**
 * Run `turbo run dev` with the repo-root .env loaded into the environment.
 *
 * `turbo` does NOT load .env into the processes it spawns, so services that read
 * raw process.env (meter-collector's KAFKA_ENABLED / CLICKHOUSE_ENABLED,
 * registry-mcp's REGISTRY_MCP_* , etc.) would miss their config and crash-loop.
 * Only the api-gateway worked before because it loads root .env itself via
 * dotenv. This wrapper loads .env once and passes it to every dev task.
 *
 * Dependency-free (no dotenv). Existing real env vars win over .env values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // scripts/ -> repo root
const envPath = join(root, '.env');

if (existsSync(envPath)) {
  let loaded = 0;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      loaded += 1;
    }
  }
  console.log(`[dev] loaded ${loaded} vars from .env into the service environment`);
} else {
  console.warn('[dev] no .env at repo root — services use built-in defaults');
}

const child = spawn('pnpm', ['exec', 'turbo', 'run', 'dev'], {
  stdio: 'inherit',
  shell: true,
  cwd: root,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
