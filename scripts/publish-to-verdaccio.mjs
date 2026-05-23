#!/usr/bin/env node
/**
 * Publishes every workspace package whose package.json declares
 * publishConfig.registry pointing at the local Verdaccio (4873) to that
 * registry. Skips packages without publishConfig.
 *
 * Closes AC-19. Usage:
 *   pnpm verdaccio:up                  # start the local Verdaccio (docker)
 *   pnpm publish:verdaccio:dry         # dry-run (pack but don't push)
 *   pnpm publish:verdaccio             # actually publish
 *
 * Auth: Verdaccio's default config allows the `$all` group to publish, so
 * no token is needed for local dev. For CI/staging, run
 *   npm adduser --registry=http://verdaccio.internal:4873/
 * once and let .npmrc cache the auth token.
 */
import { execSync } from 'child_process';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const DRY = process.argv.includes('--dry-run');
const REGISTRY = process.env.VERDACCIO_URL || 'http://localhost:4873/';

const ROOTS = ['packages', 'native'];
const targets = [];
for (const root of ROOTS) {
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry);
    if (!statSync(dir).isDirectory()) continue;
    const pkgPath = join(dir, 'package.json');
    let pkg;
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); }
    catch { continue; }
    if (!pkg.publishConfig?.registry) continue;
    if (!pkg.publishConfig.registry.includes('4873')) continue;
    targets.push({ dir, name: pkg.name, version: pkg.version });
  }
}

console.log(`Found ${targets.length} publishable packages targeting Verdaccio.`);
let okCount = 0, failCount = 0;

for (const t of targets) {
  const cmd = DRY
    ? `npm pack --dry-run`
    : `npm publish --registry=${REGISTRY} --access=restricted`;
  try {
    console.log(`\n[${DRY ? 'DRY' : 'PUBLISH'}] ${t.name}@${t.version} (${t.dir})`);
    execSync(cmd, { cwd: t.dir, stdio: 'inherit' });
    okCount++;
  } catch (err) {
    console.error(`  ✗ failed: ${err.message}`);
    failCount++;
  }
}

console.log(`\nDone. ok=${okCount} failed=${failCount}${DRY ? ' (dry-run; nothing was pushed)' : ''}`);
if (failCount > 0) process.exit(1);
