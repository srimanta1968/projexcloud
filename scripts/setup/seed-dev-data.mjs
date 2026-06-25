#!/usr/bin/env node
/**
 * Seed a freshly-migrated ProjexCloud database with the baseline metadata a
 * developer needs to exercise the platform:
 *
 *   1. All pricing-catalog seeds under seeds/pricing-catalog/*.json
 *      (delegates to scripts/apply-pricing-seed.mjs — sdk-meter catalogs/rates).
 *   2. A development tenant via POST /admin/tenants (the gateway's operator API,
 *      gated by the ADMIN_OPS_TOKEN shared secret).
 *
 * The schema itself is created automatically by the api-gateway on boot
 * (runMigrations[...]), so this script only adds DATA, never DDL. It is
 * idempotent: pricing rates upsert, and a duplicate tenant app_id is reported
 * and skipped rather than failing the run.
 *
 * Prerequisites:
 *   - Workspace built:        pnpm -w build
 *   - DB env present in .env  (DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD)
 *   - api-gateway running and healthy (for the tenant step):  GET /health
 *   - ADMIN_OPS_TOKEN exported / in .env  (for the tenant step)
 *
 * Usage:
 *   node scripts/setup/seed-dev-data.mjs                 # pricing + dev tenant
 *   node scripts/setup/seed-dev-data.mjs --pricing-only  # skip the tenant
 *   node scripts/setup/seed-dev-data.mjs --gateway http://localhost:3000
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

// Minimal .env loader (no dotenv dependency): populate process.env from the
// repo-root .env for any key not already set, so ADMIN_OPS_TOKEN / DB_* / PORT
// are available exactly as the gateway sees them.
function loadDotEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

function parseArgs() {
  const a = process.argv.slice(2);
  const o = {
    pricingOnly: a.includes('--pricing-only'),
    tenantOnly: a.includes('--tenant-only'),
    gateway: process.env.GATEWAY_URL || 'http://localhost:3000',
    adminToken: process.env.ADMIN_OPS_TOKEN || '',
    operator: 'dev-seed',
  };
  const gi = a.indexOf('--gateway');
  if (gi >= 0 && a[gi + 1]) o.gateway = a[gi + 1];
  const ti = a.indexOf('--admin-token');
  if (ti >= 0 && a[ti + 1]) o.adminToken = a[ti + 1];
  return o;
}

function applyPricingSeeds(operator) {
  const seedsDir = join(ROOT, 'seeds', 'pricing-catalog');
  const files = readdirSync(seedsDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.warn('No pricing-catalog seed files found — skipping.');
    return;
  }
  console.log(`\n=== Pricing catalogs (${files.length} seed file(s)) ===`);
  let failed = 0;
  for (const f of files) {
    const seedPath = join(seedsDir, f);
    console.log(`\n→ ${f}`);
    const res = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'apply-pricing-seed.mjs'), seedPath, '--operator', operator],
      { cwd: ROOT, stdio: 'inherit', env: process.env },
    );
    if (res.status !== 0) {
      failed += 1;
      console.error(`  ✗ ${f} exited with code ${res.status}`);
    }
  }
  if (failed) console.warn(`\n${failed} pricing seed(s) reported errors (see above).`);
  else console.log('\n✓ All pricing catalogs applied.');
}

const DEV_TENANT = {
  app_id: 'dev-app',
  display_name: 'Development Tenant',
  region: 'us-east-1',
  isolation_tier: 'S',
  module_subscriptions: [],
};

async function waitForGateway(base, attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function seedDevTenant({ gateway, adminToken }) {
  console.log(`\n=== Development tenant (${gateway}) ===`);
  if (!adminToken) {
    console.warn('ADMIN_OPS_TOKEN not set — skipping tenant creation.');
    console.warn('Export ADMIN_OPS_TOKEN (same value the gateway runs with) and re-run with --tenant-only.');
    return;
  }
  console.log('Waiting for gateway /health …');
  if (!(await waitForGateway(gateway))) {
    console.error(`✗ Gateway not healthy at ${gateway}. Start it (pnpm --filter @projexlight/api-gateway dev) and retry.`);
    process.exitCode = 2;
    return;
  }
  // A tenant references a parent app (tenant.app_id FK). Ensure it first.
  const appRes = await fetch(`${gateway}/admin/apps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-ops-token': adminToken },
    body: JSON.stringify({ app_id: DEV_TENANT.app_id, display_name: 'Development App' }),
  });
  if (appRes.status === 201) {
    console.log(`✓ Parent app ensured: app_id=${DEV_TENANT.app_id}`);
  } else {
    console.warn(`  ! /admin/apps returned ${appRes.status}: ${await appRes.text()}`);
  }
  const res = await fetch(`${gateway}/admin/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-ops-token': adminToken },
    body: JSON.stringify(DEV_TENANT),
  });
  const text = await res.text();
  if (res.status === 201) {
    console.log(`✓ Dev tenant created: app_id=${DEV_TENANT.app_id}`);
    console.log(`  ${text}`);
  } else if (res.status === 400 && /exist|duplicate|unique/i.test(text)) {
    console.log(`✓ Dev tenant already exists (app_id=${DEV_TENANT.app_id}) — nothing to do.`);
  } else if (res.status === 401) {
    console.error('✗ 401 from /admin/tenants — ADMIN_OPS_TOKEN does not match the gateway.');
    process.exitCode = 2;
  } else {
    console.error(`✗ Unexpected ${res.status} from /admin/tenants: ${text}`);
    process.exitCode = 2;
  }
}

async function main() {
  const o = parseArgs();
  console.log('ProjexCloud dev-data seeder');
  if (!o.tenantOnly) applyPricingSeeds(o.operator);
  if (!o.pricingOnly) await seedDevTenant(o);
  console.log('\nSeeding complete.');
}

main().catch((err) => {
  console.error('Fatal:', err?.message || err);
  process.exit(1);
});
