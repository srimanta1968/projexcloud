import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { applyRate, loadCatalogRates } from './rateEngine';
import { getUsageReader } from './usageReader';
import type {
  RepriceDryRunInput,
  RepriceDryRunRecord,
  UsageBucket,
} from '../models/billing.model';

/**
 * Reprice dry-run per FR-BIL-6.
 *
 * Replays a tenant's usage for any past period under TWO catalogs (baseline
 * vs target) and writes a billing.reprice_dry_run row with the per-SKU
 * delta. Pricing teams use this to estimate the impact of a catalog change
 * before publishing the new catalog.
 *
 * Side-effect-free for billing.invoice / billing.line_item — only writes
 * the dry-run row + audit envelope.
 */

export interface RepriceDryRunResult {
  dry_run: RepriceDryRunRecord;
  baseline_total: number;
  target_total: number;
}

export async function runRepriceDryRun(
  input: RepriceDryRunInput,
): Promise<RepriceDryRunResult> {
  const usage = input.usage ?? await getUsageReader().readUsage({
    tenant_id: input.tenant_id,
    period_start: input.period_start,
    period_end: input.period_end,
  });

  const baseline = await priceWithCatalog(input.baseline_catalog_id, usage);
  const target = await priceWithCatalog(input.target_catalog_id, usage);

  const delta_by_sku: Record<string, number> = {};
  const skus = new Set<string>([...Object.keys(baseline.by_sku), ...Object.keys(target.by_sku)]);
  for (const sku of skus) {
    const b = baseline.by_sku[sku] ?? 0;
    const t = target.by_sku[sku] ?? 0;
    delta_by_sku[sku] = round4(t - b);
  }
  const delta_amount = round4(target.total - baseline.total);

  const rows = await dataService.rows<RepriceDryRunRecord>(
    `INSERT INTO billing.reprice_dry_run (
       tenant_id, period_start, period_end,
       baseline_catalog_id, target_catalog_id,
       delta_amount, delta_by_sku
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING dry_run_id, tenant_id, period_start, period_end,
               baseline_catalog_id, target_catalog_id,
               delta_amount, delta_by_sku, computed_at`,
    [
      input.tenant_id,
      input.period_start,
      input.period_end,
      input.baseline_catalog_id,
      input.target_catalog_id,
      String(delta_amount),
      JSON.stringify(delta_by_sku),
    ],
  );

  await appendAuditEntry({
    pool_index: 'admin',
    event_type: 'billing.reprice.dry-run.completed.v1',
    tenant_id: input.tenant_id,
    actor_kind: 'service',
    actor_id: 'sdk-billing',
    subject_kind: 'reprice_dry_run',
    subject_id: rows[0].dry_run_id,
    payload: {
      dry_run_id: rows[0].dry_run_id,
      baseline_catalog_id: input.baseline_catalog_id,
      target_catalog_id: input.target_catalog_id,
      delta_amount,
    },
  });

  return {
    dry_run: rows[0],
    baseline_total: baseline.total,
    target_total: target.total,
  };
}

async function priceWithCatalog(
  catalog_id: string,
  usage: UsageBucket[],
): Promise<{ total: number; by_sku: Record<string, number> }> {
  const rates = await loadCatalogRates(catalog_id);
  const by_sku: Record<string, number> = {};
  let total = 0;
  for (const b of usage) {
    const rate = rates.get(b.sku);
    if (!rate) continue;
    const applied = applyRate(rate, b);
    by_sku[b.sku] = (by_sku[b.sku] ?? 0) + applied.amount;
    total += applied.amount;
  }
  return { total: round4(total), by_sku };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
