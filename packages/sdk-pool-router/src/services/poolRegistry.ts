import { dataService } from '@projexlight/db-runtime';
import { log } from '@projexlight/telemetry';
import { getCache, getDefaultTtlMs } from './routeCache';

export type PoolFamily = 'admin' | 'app' | 'evidence' | 'warehouse' | 'vector';
export type PoolStatus =
  | 'ACTIVE' | 'MIGRATING' | 'DRAINING' | 'MAINTENANCE' | 'RETIRED' | 'QUARANTINE';
export type IsolationClass = 'shared' | 'dedicated';

export interface PoolRecord {
  pool_index: string;
  pool_family: PoolFamily;
  app_id: string | null;
  region: string;
  status: PoolStatus;
  capacity_tenants: number;
  current_tenants: number;
  capacity_bytes: number;
  current_bytes: number;
  primary_endpoint: string;
  replica_endpoints: string[];
  kek_arn: string | null;
  isolation_class: IsolationClass;
}

export interface ResolveResult {
  pool_index: string;
  pool_family: PoolFamily;
  region: string;
  primary_endpoint: string;
  status: PoolStatus;
}

interface TenantPoolMapRow {
  admin_pool_index: string;
  evidence_pool_index: string | null;
  app_pool_index: Record<string, string>;
  region: string;
  status: string;
}

/**
 * Resolves a (tenant_id, app_id) tuple to its assigned pool per P1 §8.1.
 * Cache-first per FR-PR-1: checks the in-memory/Redis route cache; on miss
 * falls back to Postgres and writes through. Emits routing latency telemetry
 * per FR-PR-5.
 */
export async function resolveTenantPool(
  tenant_id: string,
  app_id: string,
): Promise<ResolveResult | null> {
  const started = Date.now();
  const cache = getCache();
  try {
    const cached = await cache.get(tenant_id, app_id);
    if (cached) {
      const latency_ms = Date.now() - started;
      log.info('pool-router.resolve.hit', { tenant_id, app_id, latency_ms });
      return cached;
    }

    const map = await dataService.one<TenantPoolMapRow>(
      `SELECT admin_pool_index, evidence_pool_index, app_pool_index, region, status
         FROM routing.tenant_pool_map WHERE tenant_id = $1`,
      [tenant_id],
    );
    if (!map) {
      log.warn('pool-router.resolve.no-map', { tenant_id, app_id });
      return null;
    }

    let target_index: string | null = null;
    if (app_id === '__admin__') target_index = map.admin_pool_index;
    else if (app_id === '__evidence__') target_index = map.evidence_pool_index;
    else target_index = map.app_pool_index?.[app_id] ?? null;

    if (!target_index) {
      log.warn('pool-router.resolve.no-target', { tenant_id, app_id });
      return null;
    }

    const result = await dataService.one<ResolveResult>(
      `SELECT pool_index, pool_family, region, primary_endpoint, status
         FROM routing.pool WHERE pool_index = $1 AND status = 'ACTIVE'`,
      [target_index],
    );

    if (result) {
      await cache.set(tenant_id, app_id, result, getDefaultTtlMs());
    }
    const latency_ms = Date.now() - started;
    log.info('pool-router.resolve.miss', { tenant_id, app_id, latency_ms });
    return result;
  } catch (err) {
    throw err;
  }
}

/**
 * Lists active pools filtered by family/region. Used by the allocator and the
 * admin portal Pool Health view.
 */
export async function listActivePools(family?: PoolFamily, region?: string): Promise<PoolRecord[]> {
  try {
    const conditions: string[] = [`status = 'ACTIVE'`];
    const params: unknown[] = [];
    if (family) {
      params.push(family);
      conditions.push(`pool_family = $${params.length}`);
    }
    if (region) {
      params.push(region);
      conditions.push(`region = $${params.length}`);
    }
    return await dataService.rows<PoolRecord>(
      `SELECT pool_index, pool_family, app_id, region, status,
              capacity_tenants, current_tenants, capacity_bytes, current_bytes,
              primary_endpoint, replica_endpoints, kek_arn, isolation_class
         FROM routing.pool
        WHERE ${conditions.join(' AND ')}
        ORDER BY (capacity_tenants - current_tenants) DESC`,
      params,
    );
  } catch (err) {
    throw err;
  }
}
