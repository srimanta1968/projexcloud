import { dataService } from '@projexlight/db-runtime';
import { resolveTenantPool } from './poolRegistry';
import type { ResolveResult } from './poolRegistry';

export interface TenantContext {
  tenantId: string;
  appId: string;
  role?: string;
}

export interface TenantBoundDb {
  pool: ResolveResult;
  context: TenantContext;
  /**
   * Tenant-scoped query helper. Sets `app.tenant_id` and `app.app_id` GUCs so
   * any RLS policy expecting `current_setting('app.tenant_id')` evaluates
   * correctly. P1 prototype: runs on the shared pool; P7 federation upgrades
   * this to route per-pool DSNs.
   */
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

class TenantNotFoundError extends Error {
  constructor(tenantId: string, appId: string) {
    super(`No active pool assignment for tenant_id=${tenantId} app_id=${appId}`);
    this.name = 'TenantNotFoundError';
  }
}

/**
 * The sanctioned tenant-scoped DB access pattern per Architecture OC-3.
 * Resolves the tenant's pool, then invokes the callback with a DB handle that
 * has RLS context set. Production wires per-pool connection pools through the
 * pool router; the prototype uses the shared @projexlight/db-runtime pool.
 */
export async function withTenant<T>(
  context: TenantContext,
  fn: (db: TenantBoundDb) => Promise<T>,
): Promise<T> {
  const pool = await resolveTenantPool(context.tenantId, context.appId);
  if (!pool) {
    throw new TenantNotFoundError(context.tenantId, context.appId);
  }

  const handle: TenantBoundDb = {
    pool,
    context,
    async query<TRow extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<TRow[]> {
      try {
        await dataService.query(`SET LOCAL app.tenant_id = $1`, [context.tenantId]);
        await dataService.query(`SET LOCAL app.app_id = $1`, [context.appId]);
        return await dataService.rows<TRow>(sql, params);
      } catch (err) {
        throw err;
      }
    },
  };

  try {
    return await fn(handle);
  } catch (err) {
    throw err;
  }
}

export { TenantNotFoundError };
