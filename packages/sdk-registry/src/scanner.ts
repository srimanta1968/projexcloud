/**
 * P9 / E2.F1 — build-time SDK scanner.
 *
 * Walks the monorepo and returns every @projexlight/* package that ships
 * an sdk-capability.json. Validates each manifest via the sdk-capability
 * package; rejects builds where any manifest is missing or invalid
 * (delegated to caller — scanner just surfaces structured results).
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest, SdkCapabilityManifest } from '@projexlight/sdk-capability';

export type ScanStatus = 'OK' | 'MISSING' | 'INVALID_JSON' | 'INVALID';

export interface ScanResult {
  /** Workspace-relative path, e.g. "packages/sdk-vault". */
  path: string;
  /** @projexlight/* package name from package.json. */
  name: string;
  status: ScanStatus;
  /** Populated when status === 'OK'. */
  manifest?: SdkCapabilityManifest;
  /** Populated otherwise. */
  errors: string[];
}

export interface ScanOptions {
  /** Absolute path to the monorepo root. */
  repoRoot: string;
  /** Which top-level directories to scan; default ["packages", "services"]. */
  topDirs?: string[];
}

export function scanWorkspace(opts: ScanOptions): ScanResult[] {
  const tops = opts.topDirs ?? ['packages', 'services'];
  const results: ScanResult[] = [];

  for (const top of tops) {
    const dir = join(opts.repoRoot, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const sub = join(dir, entry);
      if (!statSync(sub).isDirectory()) continue;
      const pkgPath = join(sub, 'package.json');
      if (!existsSync(pkgPath)) continue;

      let pkg: { name?: string };
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        continue;
      }
      const name = typeof pkg.name === 'string' ? pkg.name : '';
      if (!name.startsWith('@projexlight/')) continue;

      const relPath = `${top}/${entry}`;
      const manifestPath = join(sub, 'sdk-capability.json');

      if (!existsSync(manifestPath)) {
        results.push({
          path: relPath,
          name,
          status: 'MISSING',
          errors: ['sdk-capability.json not found'],
        });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      } catch (err) {
        results.push({
          path: relPath,
          name,
          status: 'INVALID_JSON',
          errors: [(err as Error).message],
        });
        continue;
      }

      const r = validateManifest(parsed);
      if (!r.ok) {
        results.push({ path: relPath, name, status: 'INVALID', errors: r.errors });
        continue;
      }
      results.push({ path: relPath, name, status: 'OK', manifest: r.value, errors: [] });
    }
  }

  // Stable order: by relative path.
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}
