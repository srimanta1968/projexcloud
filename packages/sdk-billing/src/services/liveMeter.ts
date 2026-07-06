import { dataService } from '@projexlight/db-runtime';
import { applyRate, loadCatalogRates } from './rateEngine';
import { getUsageReader, tableExists } from './usageReader';
import type { LiveMeterInput, LiveMeterResult } from '../models/billing.model';

/**
 * /billing/live customer dashboard per FR-BIL-7.
 *
 * SLA: ≤ 60s lag between meter event ingest and dashboard read. The
 * synthetic adapter reads the same usage_event table sdk-meter writes to,
 * so the lag is bounded by Postgres replication; production swaps in a
 * Redis live counter that sdk-meter maintains.
 *
 * Picks the currently-active catalog for the tenant by reading the most
 * recent active catalog from meter.pricing_catalog.
 */

export async function readLiveMeter(input: LiveMeterInput): Promise<LiveMeterResult> {
  const now = new Date();
  const period_start = firstOfMonthIso(now);

  const catalog = await dataService.one<{ catalog_id: string }>(
    `SELECT catalog_id FROM meter.pricing_catalog
      WHERE status = 'active'
      ORDER BY effective_from DESC LIMIT 1`,
  );
  if (!catalog) {
    return {
      tenant_id: input.tenant_id,
      as_of: now,
      current_period_start: period_start,
      subtotal: 0,
      lag_ms: 0,
      by_sku: {},
    };
  }

  const rates = await loadCatalogRates(catalog.catalog_id);
  const usage = await getUsageReader().readUsage({
    tenant_id: input.tenant_id,
    period_start,
    period_end: dateOnlyIso(now),
  });

  const by_sku: Record<string, { units: number; amount: number }> = {};
  let subtotal = 0;
  for (const b of usage) {
    const rate = rates.get(b.sku);
    if (!rate) continue;
    const applied = applyRate(rate, b);
    const prev = by_sku[b.sku] ?? { units: 0, amount: 0 };
    by_sku[b.sku] = {
      units: prev.units + b.units,
      amount: round4(prev.amount + applied.amount),
    };
    subtotal += applied.amount;
  }

  // Lag computed as: now - max(occurred_at). In synthetic mode that's
  // effectively zero; production reports Redis-counter age. usage_event is a
  // ClickHouse-only table — guard so the Postgres deploy doesn't 500 on a
  // missing relation.
  let lag_ms = 0;
  if (await tableExists('meter', 'usage_event')) {
    const lagRow = await dataService.one<{ lag_ms: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - MAX(occurred_at)))::bigint * 1000 AS lag_ms
         FROM meter.usage_event
        WHERE tenant_id = $1 AND occurred_at >= $2`,
      [input.tenant_id, period_start],
    );
    lag_ms = lagRow?.lag_ms ?? 0;
  }

  return {
    tenant_id: input.tenant_id,
    as_of: now,
    current_period_start: period_start,
    subtotal: round4(subtotal),
    lag_ms,
    by_sku,
  };
}

function firstOfMonthIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function dateOnlyIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
