#!/usr/bin/env node
/**
 * Normalise publishConfig across every publishable @projexlight package (P16 · EP-387).
 *
 * THE BUG THIS FIXES. Every package that already carried a publishConfig hardcoded
 * `registry: "http://localhost:4873/"`. npm resolves the publish target as
 * publishConfig.registry > .npmrc scope registry > default, so a hardcoded value WINS over
 * whatever CI sets — meaning a production release would quietly publish to the developer's
 * laptop registry and appear to succeed. Removing the field lets the scoped entry in
 * .npmrc decide, which is the one place that can differ between dev and prod.
 *
 * `access: "restricted"` is kept, because that is a property of the PACKAGE (these are
 * private) rather than of the environment publishing it.
 *
 * Idempotent: run it as often as you like. `--check` exits non-zero instead of writing,
 * which is what CI uses to stop the hardcoded registry creeping back in.
 */
const fs = require('fs');
const path = require('path');

const CHECK = process.argv.includes('--check');
const ROOT = path.resolve(__dirname, '..', '..');
const PKG_DIR = path.join(ROOT, 'packages');

/**
 * Packages verticals depend on. These MUST be installable from the registry — a vertical
 * that cannot resolve one of them has to vendor the source, which is the situation this
 * whole epic exists to end.
 */
const REQUIRED_PUBLISHABLE = [
  'sdk-source-record', 'sdk-import', 'sdk-sla', 'sdk-coverage', 'sdk-data-credits',
  'sdk-crm', 'sdk-assignment', 'sdk-identity-resolver', 'sdk-lead-scoring', 'sdk-ingest',
  'sdk-audit', 'sdk-conversation', 'sdk-parsing', 'sdk-evidence',
];

/** Apps and services are deployed, never installed as a dependency. */
const NEVER_PUBLISH = new Set(['api-gateway', 'meter-collector', 'identity-projector', 'usage-reconciler', 'tenant-workspace']);

const problems = [];
const changed = [];

function shortName(pkgName) {
  return pkgName.replace('@projexlight/', '');
}

/**
 * Publishing a package without its dependencies is the trap this closure exists to avoid.
 *
 * `sdk-conversation` depends on `@projexlight/db-runtime`. If only the former is published,
 * `pnpm add @projexlight/sdk-conversation` SUCCEEDS and then fails to resolve db-runtime —
 * and the only fix available to a consumer is to vendor the source, which is the exact
 * outcome this epic exists to end. So the publishable set is the transitive closure of the
 * listed packages, not the list itself.
 */
function resolvePublishClosure(required) {
  const readByDir = (dir) => {
    const f = path.join(PKG_DIR, dir, 'package.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const dirByName = new Map();
  for (const dir of fs.readdirSync(PKG_DIR)) {
    const j = readByDir(dir);
    if (j && j.name) dirByName.set(j.name, dir);
  }

  const closure = new Set();
  const queue = [...required];
  while (queue.length) {
    const dir = queue.shift();
    if (closure.has(dir)) continue;
    const pkg = readByDir(dir);
    if (!pkg) continue;
    if (NEVER_PUBLISH.has(shortName(pkg.name ?? ''))) continue;
    closure.add(dir);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (!dep.startsWith('@projexlight/')) continue;
      const depDir = dirByName.get(dep);
      // A dep resolved outside packages/ is a service, which is never a dependency.
      if (depDir && !closure.has(depDir)) queue.push(depDir);
    }
  }
  return [...closure];
}

const PUBLISH_CLOSURE = resolvePublishClosure(REQUIRED_PUBLISHABLE);

for (const dir of fs.readdirSync(PKG_DIR)) {
  const file = path.join(PKG_DIR, dir, 'package.json');
  if (!fs.existsSync(file)) continue;

  const raw = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  if (!pkg.name || !pkg.name.startsWith('@projexlight/')) continue;
  if (NEVER_PUBLISH.has(shortName(pkg.name))) continue;

  const required = PUBLISH_CLOSURE.includes(dir);
  const alreadyPublishable = Boolean(pkg.publishConfig) || pkg.private === false;
  if (!required && !alreadyPublishable) continue;

  let dirty = false;

  // 1. private:false — a private package is silently skipped by `npm publish`, so a
  //    vertical would get a 404 with no clue why.
  if (pkg.private !== false) { pkg.private = false; dirty = true; }

  // 2. publishConfig WITHOUT a registry, so .npmrc (and therefore CI) decides.
  const wantAccess = 'restricted';
  if (!pkg.publishConfig || pkg.publishConfig.access !== wantAccess || pkg.publishConfig.registry !== undefined) {
    pkg.publishConfig = { access: wantAccess };
    dirty = true;
  }

  // 3. A consumer resolves entrypoints from main/types; without them the install
  //    succeeds and every import fails, which is a worse failure than not installing.
  if (!pkg.main) { pkg.main = 'dist/index.js'; dirty = true; }
  if (!pkg.types) { pkg.types = 'dist/index.d.ts'; dirty = true; }

  // 4. files — without it npm packs the whole directory including src and tests.
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    pkg.files = ['dist', 'README.md'];
    dirty = true;
  }
  // Migrations ship as .sql read at runtime by the migration runner, so a package that
  // has them must include them or the gateway boots against an unmigrated schema.
  const hasMigrations = fs.existsSync(path.join(PKG_DIR, dir, 'src', 'db', 'migrations'));
  if (hasMigrations && !pkg.files.includes('src/db/migrations')) {
    pkg.files.push('src/db/migrations');
    dirty = true;
  }

  if (!pkg.version) { problems.push(`${pkg.name}: no version`); }

  if (dirty) {
    changed.push(pkg.name);
    if (!CHECK) fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

// Every required package must actually exist.
for (const dir of PUBLISH_CLOSURE) {
  if (!fs.existsSync(path.join(PKG_DIR, dir, 'package.json'))) {
    problems.push(`required publishable package missing: ${dir}`);
  }
}

if (CHECK) {
  if (changed.length || problems.length) {
    console.error('publishConfig drift detected:');
    for (const c of changed) console.error(`  needs normalising: ${c}`);
    for (const p of problems) console.error(`  ${p}`);
    console.error('\nRun: node scripts/release/normalize-publish-config.js');
    process.exit(1);
  }
  console.log(`publishConfig OK — no drift across ${PUBLISH_CLOSURE.length} packages in the publish closure.`);
} else {
  console.log(`normalised ${changed.length} package(s)`);
  for (const c of changed) console.log(`  ${c}`);
  if (problems.length) {
    for (const p of problems) console.error(`  PROBLEM: ${p}`);
    process.exit(1);
  }
}
