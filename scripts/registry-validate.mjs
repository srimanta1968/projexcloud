#!/usr/bin/env node
/**
 * P9 / E1.F4 — registry-validate CI gate.
 *
 * Walks every packages/* and services/* directory. For each one:
 *   - If the directory looks like an SDK (has a package.json with
 *     name starting "@projexlight/"), an sdk-capability.json is REQUIRED.
 *   - The manifest is validated via @projexlight/sdk-capability.validateManifest
 *     (both schema rules and quality lints).
 *
 * Exit codes:
 *   0  All manifests present and valid.
 *   1  One or more MANIFEST_MISSING or MANIFEST_INVALID.
 *   2  Internal error.
 *
 * Output:
 *   Default: human-readable, grouped by package.
 *   --json:  one JSON object on stdout for CI to annotate the PR.
 *
 * Usage:
 *   pnpm registry:validate
 *   pnpm registry:validate --json
 *   pnpm registry:validate --allow-missing   # warn-only on missing (one-time bootstrap)
 *
 * Doctrine §C: every SDK ships sdk-capability.json at v1.0. CI rejects PRs
 * that violate this without exception.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const ALLOW_MISSING = args.includes('--allow-missing');

// Lazily import the validator from the workspace package's compiled output.
// We avoid a top-level import so missing build artifacts produce a clear
// error rather than a confusing ESM resolution failure.
async function loadValidator() {
  const distPath = resolve(REPO_ROOT, 'packages/sdk-capability/dist/index.js');
  if (!existsSync(distPath)) {
    fail(
      2,
      `sdk-capability is not built. Run: pnpm --filter @projexlight/sdk-capability build`,
    );
  }
  const mod = await import(`file://${distPath}`);
  if (typeof mod.validateManifest !== 'function') {
    fail(2, `sdk-capability dist is corrupt: validateManifest export missing`);
  }
  return mod.validateManifest;
}

function fail(code, msg) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function listSdkDirs() {
  const out = [];
  for (const top of ['packages', 'services']) {
    const dir = resolve(REPO_ROOT, top);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const sub = join(dir, entry);
      if (!statSync(sub).isDirectory()) continue;
      const pkgPath = join(sub, 'package.json');
      if (!existsSync(pkgPath)) continue;
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      } catch {
        continue;
      }
      const name = typeof pkg.name === 'string' ? pkg.name : '';
      if (!name.startsWith('@projexlight/')) continue;
      out.push({
        path: sub,
        relPath: `${top}/${entry}`,
        name,
        manifestPath: join(sub, 'sdk-capability.json'),
      });
    }
  }
  return out;
}

async function validateOne(sdk, validateManifest) {
  if (!existsSync(sdk.manifestPath)) {
    return {
      ...sdk,
      status: 'MISSING',
      errors: ['sdk-capability.json not found'],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(sdk.manifestPath, 'utf-8'));
  } catch (err) {
    return {
      ...sdk,
      status: 'INVALID_JSON',
      errors: [(err && err.message) || String(err)],
    };
  }
  const r = validateManifest(parsed);
  if (r.ok) return { ...sdk, status: 'OK', errors: [] };
  return { ...sdk, status: 'INVALID', errors: r.errors };
}

async function main() {
  const validateManifest = await loadValidator();
  const sdks = listSdkDirs();
  const results = await Promise.all(sdks.map((s) => validateOne(s, validateManifest)));

  const counts = {
    total: results.length,
    ok: results.filter((r) => r.status === 'OK').length,
    missing: results.filter((r) => r.status === 'MISSING').length,
    invalid_json: results.filter((r) => r.status === 'INVALID_JSON').length,
    invalid: results.filter((r) => r.status === 'INVALID').length,
  };

  const blocking =
    counts.invalid + counts.invalid_json + (ALLOW_MISSING ? 0 : counts.missing);

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({ counts, results }, null, 2) + '\n');
  } else {
    process.stdout.write(`\nregistry-validate — scanned ${counts.total} SDK(s)\n`);
    process.stdout.write(
      `  OK: ${counts.ok}   MISSING: ${counts.missing}   INVALID_JSON: ${counts.invalid_json}   INVALID: ${counts.invalid}\n\n`,
    );
    for (const r of results) {
      if (r.status === 'OK') continue;
      const prefix = r.status === 'MISSING' && ALLOW_MISSING ? 'WARN ' : 'FAIL ';
      process.stdout.write(`${prefix}${r.status}: ${r.relPath} (${r.name})\n`);
      for (const e of r.errors) process.stdout.write(`       - ${e}\n`);
    }
    if (blocking > 0) {
      process.stdout.write(
        `\nDoctrine §C requires every SDK to ship sdk-capability.json. ` +
          `Run \`pnpm --filter <pkg> exec sdk-capability scaffold\` then fill in the prose sections.\n`,
      );
    } else if (counts.missing > 0 && ALLOW_MISSING) {
      process.stdout.write(
        `\n${counts.missing} manifest(s) missing — allowed by --allow-missing. ` +
          `Remove this flag before P9 GA gate.\n`,
      );
    } else {
      process.stdout.write(`\nAll manifests valid.\n`);
    }
  }

  process.exit(blocking > 0 ? 1 : 0);
}

main().catch((err) => fail(2, `internal error: ${(err && err.stack) || err}`));
