import { dataService } from '@projexlight/db-runtime';

export type PricingUnit = 'call' | 'byte' | 'doc' | 'token' | 'GB-mo';
export type PricingMode =
  | 'flat_per_call'
  | 'tiered_per_call'
  | 'passthrough_plus_margin'
  | 'per_unit'
  | 'bundled_subscription'
  | 'free_internal';

export interface PricingRate {
  rate_id: string;
  catalog_id: string;
  sku: string;
  unit: PricingUnit;
  mode: PricingMode;
  tiers: unknown;
  price: number | null;
  margin_pct: number | null;
  currency: string;
}

/**
 * Looks up the currently-active rate for a SKU per FR-MET-8. Returns null if
 * no active catalog contains the SKU. Production wraps this with a Redis
 * `catalog:active:{app_id}` cache (P1-Foundation-Spine §9.4); the prototype
 * hits Postgres directly.
 */
export async function lookupRate(sku: string): Promise<PricingRate | null> {
  try {
    return await dataService.one<PricingRate>(
      `SELECT pr.rate_id, pr.catalog_id, pr.sku, pr.unit, pr.mode, pr.tiers,
              pr.price, pr.margin_pct, pr.currency
         FROM meter.pricing_rate pr
         JOIN meter.pricing_catalog pc ON pc.catalog_id = pr.catalog_id
        WHERE pr.sku = $1
          AND pc.status = 'active'
          AND (pc.effective_from IS NULL OR pc.effective_from <= now())
          AND (pc.effective_to IS NULL OR pc.effective_to > now())
        ORDER BY pc.version DESC
        LIMIT 1`,
      [sku],
    );
  } catch (err) {
    throw err;
  }
}

/**
 * Lists all active rates. Useful for the admin pricing-catalog UI.
 */
export async function listActiveRates(): Promise<PricingRate[]> {
  try {
    return await dataService.rows<PricingRate>(
      `SELECT pr.rate_id, pr.catalog_id, pr.sku, pr.unit, pr.mode, pr.tiers,
              pr.price, pr.margin_pct, pr.currency
         FROM meter.pricing_rate pr
         JOIN meter.pricing_catalog pc ON pc.catalog_id = pr.catalog_id
        WHERE pc.status = 'active'
          AND (pc.effective_from IS NULL OR pc.effective_from <= now())
          AND (pc.effective_to IS NULL OR pc.effective_to > now())
        ORDER BY pr.sku ASC`,
    );
  } catch (err) {
    throw err;
  }
}
