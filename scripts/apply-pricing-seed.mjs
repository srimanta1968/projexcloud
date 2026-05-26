#!/usr/bin/env node
/**
 * Apply a pricing-catalog seed JSON to the running sdk-meter pricing
 * catalog. Idempotent: catalog row created if missing; rates upserted
 * one by one. Catalog stays in draft status — operator promotes to
 * active via a separate setCatalogStatus call once the rates are
 * reviewed.
 *
 * Usage:
 *   node scripts/apply-pricing-seed.mjs seeds/pricing-catalog/registry-mcp-v1.json [--operator ops-bot]
 *
 * Requires:
 *   - sdk-meter migrations applied (meter.pricing_catalog + meter.pricing_rate)
 *   - DATABASE_URL pointing at the admin pool
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/apply-pricing-seed.mjs <seed.json> [--operator <id>] [--dry-run]');
    process.exit(1);
  }
  const flags = { dryRun: false, operator: 'seed-script' };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--operator') flags.operator = args[++i];
    else positional.push(a);
  }
  if (positional.length !== 1) {
    console.error('Expected exactly one seed-file positional argument.');
    process.exit(1);
  }
  return { seedPath: positional[0], ...flags };
}

async function main() {
  const { seedPath, dryRun, operator } = parseArgs();
  const seed = JSON.parse(readFileSync(resolve(seedPath), 'utf-8'));

  if (!seed.catalog_id || !seed.rates || !Array.isArray(seed.rates)) {
    console.error('Seed file missing required fields: catalog_id, rates[]');
    process.exit(1);
  }

  console.log(
    `Applying ${seed.rates.length} rate(s) to catalog "${seed.catalog_id}" v${seed.version}` +
      (dryRun ? ' (dry-run)' : '') +
      ` as operator=${operator}`,
  );

  if (dryRun) {
    for (const r of seed.rates) {
      console.log(`  [dry-run] upsert sku=${r.sku} unit=${r.unit} mode=${r.mode} price=${r.price}`);
    }
    console.log('\nDry-run complete; no DB changes made.');
    return;
  }

  // Lazy-import so dry-run works without a DB connection / built dist.
  const meter = await import('@projexlight/sdk-meter');

  // Ensure the catalog row exists. createCatalogVersion is idempotent on
  // (catalog_id, version); if a row exists with this version, it returns
  // the existing one without resetting status.
  let catalog;
  try {
    catalog = await meter.createCatalogVersion({
      catalog_id: seed.catalog_id,
      version: seed.version,
      created_by: operator,
    });
    console.log(`✓ catalog ${catalog.catalog_id} v${catalog.version} status=${catalog.status}`);
  } catch (err) {
    // Some impls throw on existing — try fetching directly.
    const list = await meter.listPricingCatalogs();
    catalog = list.find((c) => c.catalog_id === seed.catalog_id && c.version === seed.version);
    if (!catalog) throw err;
    console.log(`✓ catalog ${catalog.catalog_id} v${catalog.version} (existing) status=${catalog.status}`);
  }

  let ok = 0;
  let failed = 0;
  for (const r of seed.rates) {
    try {
      await meter.upsertPricingRate({
        catalog_id: seed.catalog_id,
        sku: r.sku,
        unit: r.unit,
        mode: r.mode,
        price: r.price ?? null,
        margin_pct: r.margin_pct ?? null,
        tiers: r.tiers ?? null,
        operator_id: operator,
      });
      ok += 1;
      console.log(`  ✓ ${r.sku} ${r.mode} $${r.price}/${r.unit}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${r.sku} — ${err.message}`);
    }
  }

  console.log(`\nDone: ${ok} ok / ${failed} failed.`);
  console.log(
    `Catalog stays in status='${catalog.status}'. To activate:\n` +
      `  await meter.setCatalogStatus({ catalog_id: '${seed.catalog_id}', status: 'active' })`,
  );

  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
