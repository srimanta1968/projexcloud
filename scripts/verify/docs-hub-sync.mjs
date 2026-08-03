/**
 * Fails when a portal copy of the developer hub drifts from the canonical file.
 *
 *   node scripts/verify/docs-hub-sync.mjs
 *   node scripts/verify/docs-hub-sync.mjs --fix
 *
 * The hub is served from three places: the canonical `docs/v3.1/developer-hub`
 * and a copy inside each portal's `public/`. Copies drift silently — someone
 * corrects the canonical file, the portals keep serving the old text, and the
 * page a customer actually reads is the stale one. A check is the only thing
 * that makes "kept in sync" true rather than intended.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const CANONICAL = 'docs/v3.1/developer-hub';
const COPIES = ['apps/tenant-admin/public/docs/hub', 'apps/tenant-workspace/public/docs/hub'];
const fix = process.argv.includes('--fix');

const digest = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

let drift = 0;
for (const file of readdirSync(CANONICAL).filter((f) => f.endsWith('.html'))) {
  const source = join(CANONICAL, file);
  for (const dir of COPIES) {
    const target = join(dir, file);
    let same = false;
    try {
      same = digest(source) === digest(target);
    } catch {
      same = false; // missing counts as drift, not as a crash
    }
    if (same) continue;
    drift += 1;
    if (fix) {
      writeFileSync(target, readFileSync(source));
      console.log(`  synced  ${target}`);
    } else {
      console.log(`  DRIFT   ${target} differs from ${source}`);
    }
  }
}

if (drift === 0) {
  console.log('  developer hub copies are identical to the canonical files');
  process.exit(0);
}
if (fix) {
  console.log(`\n  synced ${drift} file(s)`);
  process.exit(0);
}
console.log(`\n  ${drift} copy/copies drifted. Re-run with --fix, or update the canonical file first.`);
process.exit(1);
