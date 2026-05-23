import { dataService } from '@projexlight/db-runtime';
import type { UsageBucket } from '../models/billing.model';

/**
 * Free-tier engine per FR-BIL-3.
 *
 * Applies tenant-scoped free-tier allowances to usage buckets BEFORE rate
 * application. The free-tier config is held in tenant.free_tier_allowance
 * if the table exists; otherwise this is a no-op so deploys without the
 * tenant migration extension still work.
 *
 * Allowance config format (one row per (tenant_id, sku)):
 *   { tenant_id, sku, included_units numeric }
 *
 * Units beyond included_units pass through to rate engine; units within
 * are subtracted from the bucket. If an entire bucket fits in the
 * allowance, it's dropped from billing entirely.
 */

interface AllowanceRow {
  sku: string;
  included_units: string;
}

async function loadAllowances(tenant_id: string): Promise<Map<string, number>> {
  const tableThere = await dataService.one<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'tenant' AND table_name = 'free_tier_allowance'
     ) AS exists`,
  );
  if (!tableThere?.exists) return new Map();

  const rows = await dataService.rows<AllowanceRow>(
    `SELECT sku, included_units::text AS included_units
       FROM tenant.free_tier_allowance WHERE tenant_id = $1`,
    [tenant_id],
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.sku, Number(r.included_units));
  return map;
}

export async function applyFreeTier(
  tenant_id: string,
  usage: UsageBucket[],
): Promise<UsageBucket[]> {
  const allowances = await loadAllowances(tenant_id);
  if (allowances.size === 0) return usage;

  // Allowance is global per (tenant, sku); apply across buckets in their
  // existing order until the allowance is exhausted, then bill the rest.
  const remaining = new Map(allowances);
  const out: UsageBucket[] = [];
  for (const b of usage) {
    const left = remaining.get(b.sku) ?? 0;
    if (left <= 0) { out.push(b); continue; }
    if (b.units <= left) {
      remaining.set(b.sku, left - b.units);
      continue;
    }
    out.push({ ...b, units: b.units - left });
    remaining.set(b.sku, 0);
  }
  return out;
}
