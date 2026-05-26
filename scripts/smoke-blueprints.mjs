#!/usr/bin/env node
/**
 * AC-9 — blueprint smoke test runner.
 *
 * For each blueprint under blueprints/, runs `projex blueprint apply <id>`
 * into a tmp dir, then executes the blueprint's `tests/smoke.mjs` script if
 * present. Asserts: apply succeeded, file count > 0, smoke script exit 0.
 *
 * Run in CI: node scripts/smoke-blueprints.mjs
 *
 * Exits non-zero on any blueprint failure. Prints a summary report.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const BLUEPRINTS_DIR = join(ROOT, 'blueprints');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'dist', 'cli.js');

if (!existsSync(CLI_BIN)) {
  console.error(`CLI not built. Run: pnpm --filter @projexlight/cli build`);
  process.exit(2);
}
if (!existsSync(BLUEPRINTS_DIR)) {
  console.error(`blueprints/ not found at ${BLUEPRINTS_DIR}`);
  process.exit(2);
}

const blueprints = readdirSync(BLUEPRINTS_DIR)
  .filter((entry) => {
    const full = join(BLUEPRINTS_DIR, entry);
    return statSync(full).isDirectory() && existsSync(join(full, 'blueprint.yaml'));
  });

console.log(`Found ${blueprints.length} blueprint(s): ${blueprints.join(', ')}\n`);

const results = [];

for (const bp of blueprints) {
  const tmpDir = mkdtempSync(join(tmpdir(), `bp-smoke-${bp}-`));
  const t0 = Date.now();
  let apply_ok = false;
  let smoke_ok = null;
  let apply_error = null;
  let smoke_error = null;

  try {
    execSync(
      `node "${CLI_BIN}" blueprint apply ${bp} --root "${BLUEPRINTS_DIR}"`,
      { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PROJEX_BLUEPRINTS_ROOT: BLUEPRINTS_DIR } },
    );
    apply_ok = true;
  } catch (e) {
    apply_error = e.stderr?.toString().slice(0, 400) ?? e.message;
  }

  if (apply_ok) {
    const smokeScript = join(BLUEPRINTS_DIR, bp, 'tests', 'smoke.mjs');
    if (existsSync(smokeScript)) {
      try {
        execSync(`node "${smokeScript}"`, { cwd: tmpDir, stdio: ['ignore', 'pipe', 'pipe'] });
        smoke_ok = true;
      } catch (e) {
        smoke_ok = false;
        smoke_error = e.stderr?.toString().slice(0, 400) ?? e.message;
      }
    }
  }

  const duration_ms = Date.now() - t0;
  results.push({ blueprint: bp, apply_ok, smoke_ok, duration_ms, apply_error, smoke_error });

  // Clean up
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const passed = results.filter((r) => r.apply_ok && r.smoke_ok !== false);
const failed = results.filter((r) => !r.apply_ok || r.smoke_ok === false);

console.log(JSON.stringify({ total: results.length, passed: passed.length, failed: failed.length, results }, null, 2));

if (failed.length > 0) {
  console.error(`\nAC-9 FAIL: ${failed.length}/${results.length} blueprint(s) failed`);
  process.exit(1);
}
console.log(`\nAC-9 PASS: ${passed.length}/${results.length} blueprint(s) applied`);
