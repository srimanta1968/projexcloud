import { dataService } from '@projexlight/db-runtime';
import type { CreateTenantInput, TenantRecord } from '../models/tenant.model';

/**
 * Creates a new tenant per P2 §4. The DB trigger materializes root_tenant_id
 * from the parent chain; the SDK lifts that responsibility off callers.
 */
export async function createTenant(input: CreateTenantInput): Promise<TenantRecord> {
  try {
    const rows = await dataService.rows<TenantRecord>(
      `INSERT INTO tenant.tenant (
         app_id, display_name, region, parent_tenant_id, reseller_id,
         isolation_tier, geo_node_id, brand_domain,
         admin_pool_index, app_pool_index, module_subscriptions
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       RETURNING tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
                 isolation_tier, region, geo_node_id, brand_domain,
                 admin_pool_index, app_pool_index, module_subscriptions,
                 status, display_name, created_at, updated_at`,
      [
        input.app_id,
        input.display_name,
        input.region,
        input.parent_tenant_id ?? null,
        input.reseller_id ?? null,
        input.isolation_tier ?? 'S',
        input.geo_node_id ?? null,
        input.brand_domain ?? null,
        input.admin_pool_index ?? null,
        JSON.stringify(input.app_pool_index ?? {}),
        input.module_subscriptions ?? [],
      ],
    );
    return rows[0];
  } catch (err) {
    throw err;
  }
}

/**
 * Reads a tenant by ID. Returns null if not found. The caller may join with
 * tenant.bu / role_template / fiscal_period via separate queries when needed.
 */
export async function getTenant(tenant_id: string): Promise<TenantRecord | null> {
  try {
    return await dataService.one<TenantRecord>(
      `SELECT tenant_id, app_id, parent_tenant_id, root_tenant_id, reseller_id,
              isolation_tier, region, geo_node_id, brand_domain,
              admin_pool_index, app_pool_index, module_subscriptions,
              status, display_name, created_at, updated_at
         FROM tenant.tenant WHERE tenant_id = $1`,
      [tenant_id],
    );
  } catch (err) {
    throw err;
  }
}
