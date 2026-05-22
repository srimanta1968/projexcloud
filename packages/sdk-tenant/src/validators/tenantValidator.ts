import type { CreateTenantInput, IsolationTier } from '../models/tenant.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_TIERS: IsolationTier[] = ['S', 'P', 'G'];

/**
 * Validates POST /api/tenants payload. app_id, display_name, region required.
 */
export function validateCreateTenant(body: unknown): ValidationResult<CreateTenantInput> {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;

  const app_id = typeof b.app_id === 'string' ? b.app_id.trim() : '';
  const display_name = typeof b.display_name === 'string' ? b.display_name.trim() : '';
  const region = typeof b.region === 'string' ? b.region.trim() : '';

  if (!app_id) errors.push('app_id is required');
  if (!display_name) errors.push('display_name is required');
  if (!region) errors.push('region is required');

  const isolation_tier = typeof b.isolation_tier === 'string' ? (b.isolation_tier as IsolationTier) : undefined;
  if (isolation_tier && !VALID_TIERS.includes(isolation_tier)) {
    errors.push(`isolation_tier must be one of ${VALID_TIERS.join(', ')}`);
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      app_id,
      display_name,
      region,
      isolation_tier,
      parent_tenant_id: typeof b.parent_tenant_id === 'string' ? b.parent_tenant_id : undefined,
      reseller_id: typeof b.reseller_id === 'string' ? b.reseller_id : undefined,
      geo_node_id: typeof b.geo_node_id === 'string' ? b.geo_node_id : undefined,
      brand_domain: typeof b.brand_domain === 'string' ? b.brand_domain : undefined,
      admin_pool_index: typeof b.admin_pool_index === 'string' ? b.admin_pool_index : undefined,
      app_pool_index: (b.app_pool_index && typeof b.app_pool_index === 'object')
        ? (b.app_pool_index as Record<string, string>)
        : undefined,
      module_subscriptions: Array.isArray(b.module_subscriptions)
        ? (b.module_subscriptions as string[])
        : undefined,
    },
  };
}
