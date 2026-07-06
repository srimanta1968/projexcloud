import { dataService } from '@projexlight/db-runtime';
import type { PricingMode, PricingRate, TierBreak, UsageBucket } from '../models/billing.model';

/**
 * Rate engine per FR-BIL-1. Reads pricing.rate rows from meter.pricing_rate
 * for a given catalog_id, then applies the six pricing modes.
 *
 * The six modes:
 *   1. flat_per_call           — amount = units × rate
 *   2. tiered_per_call         — graduated tiers; piecewise sum
 *   3. passthrough_plus_margin — (vendor_cost × (1 + margin_pct))
 *   4. per_unit                — amount = units × rate (alias of flat_per_call,
 *                                kept distinct for catalog clarity)
 *   5. bundled_subscription    — flat fee (rate) for included_units; overage
 *                                applies overage_rate to units > included_units
 *   6. free_internal           — amount = 0 (always)
 */

interface MeterPricingRateRow {
  sku: string;
  pricing_mode: string;
  rate: string | null;
  tiers: TierBreak[] | null;
  margin_pct: string | null;
  included_units: string | null;
  overage_rate: string | null;
}

export async function loadCatalogRates(catalog_id: string): Promise<Map<string, PricingRate>> {
  // meter.pricing_rate columns are: sku, unit, mode, tiers, price, margin_pct,
  // currency (see sdk-meter 001_init_meter.sql). Alias mode->pricing_mode and
  // price->rate so the row mapping below is unchanged. included_units/
  // overage_rate are not modeled in the schema (bundled_subscription overage is
  // not expressible in P1), so they read as NULL.
  const rows = await dataService.rows<MeterPricingRateRow>(
    `SELECT sku, mode AS pricing_mode, price::text AS rate, tiers,
            margin_pct::text AS margin_pct,
            NULL::text AS included_units,
            NULL::text AS overage_rate
       FROM meter.pricing_rate
      WHERE catalog_id = $1`,
    [catalog_id],
  );

  const map = new Map<string, PricingRate>();
  for (const r of rows) {
    map.set(r.sku, {
      sku: r.sku,
      mode: normalizeMode(r.pricing_mode),
      rate: r.rate !== null ? Number(r.rate) : undefined,
      tiers: r.tiers ?? undefined,
      margin_pct: r.margin_pct !== null ? Number(r.margin_pct) : undefined,
      included_units: r.included_units !== null ? Number(r.included_units) : undefined,
      overage_rate: r.overage_rate !== null ? Number(r.overage_rate) : undefined,
    });
  }
  return map;
}

function normalizeMode(raw: string): PricingMode {
  const known: PricingMode[] = [
    'flat_per_call', 'tiered_per_call', 'passthrough_plus_margin',
    'per_unit', 'bundled_subscription', 'free_internal',
  ];
  return (known.includes(raw as PricingMode) ? raw : 'flat_per_call') as PricingMode;
}

export interface AppliedRate {
  /** Effective per-unit rate after tier collapse — purely informational. */
  rate: number;
  /** Total amount for this bucket. */
  amount: number;
}

export function applyRate(rate: PricingRate, bucket: UsageBucket): AppliedRate {
  if (rate.mode === 'free_internal') return { rate: 0, amount: 0 };

  if (rate.mode === 'tiered_per_call') {
    if (!rate.tiers || rate.tiers.length === 0) return { rate: 0, amount: 0 };
    return applyTiers(rate.tiers, bucket.units);
  }

  if (rate.mode === 'passthrough_plus_margin') {
    const vendor = bucket.vendor_cost ?? 0;
    const margin = rate.margin_pct ?? 0;
    const total = vendor * (1 + margin);
    const effective = bucket.units > 0 ? total / bucket.units : 0;
    return { rate: effective, amount: round4(total) };
  }

  if (rate.mode === 'bundled_subscription') {
    const flat = rate.rate ?? 0;
    const included = rate.included_units ?? 0;
    const overage = rate.overage_rate ?? 0;
    const extra = Math.max(0, bucket.units - included);
    const amount = round4(flat + extra * overage);
    const effective = bucket.units > 0 ? amount / bucket.units : 0;
    return { rate: effective, amount };
  }

  // flat_per_call + per_unit
  const r = rate.rate ?? 0;
  return { rate: r, amount: round4(bucket.units * r) };
}

function applyTiers(tiers: TierBreak[], units: number): AppliedRate {
  let remaining = units;
  let prev = 0;
  let total = 0;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const span = tier.upto === Infinity
      ? remaining
      : Math.max(0, Math.min(remaining, tier.upto - prev));
    total += span * tier.rate;
    remaining -= span;
    prev = tier.upto;
  }
  const effective = units > 0 ? total / units : 0;
  return { rate: effective, amount: round4(total) };
}

function round4(n: number): number { return Math.round(n * 10_000) / 10_000; }
