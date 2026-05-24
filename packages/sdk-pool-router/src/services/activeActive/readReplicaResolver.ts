import { getPool } from '@projexlight/db-runtime';

/**
 * Cross-region read-replica resolver (Y-P8-12 / FR-AA-3).
 *
 * For tenants with an active_active profile, this picks the nearest
 * pool_index for a READ given the request's region. Falls back to the
 * tenant's home pool when no in-region replica exists or no profile is
 * configured (cloud-default behavior).
 *
 * tenant_pool_map.replica_pool_indexes shape:
 *   { "us-east": "pool_47", "us-west": "pool_48", "eu-west": "pool_49" }
 *
 * Resolution precedence:
 *   1. If request_region maps to a replica → that pool_index.
 *   2. If profile.home_region maps to the request_region → home pool.
 *   3. Fall back to the tenant's primary pool (the default behavior).
 *
 * The helper is read-only. Writes still route via the standard
 * withTenant() / assertActiveActiveWriteAllowed() path so single-region
 * and sync modes are correctly enforced (G-P8-4).
 */

export interface ResolveReadReplicaInput {
  tenant_id: string;
  request_region: string;
  /** Optional SDK kind — reserved for future per-SDK replica preferences. */
  sdk_kind?: string;
}

export interface ResolvedReadReplica {
  pool_index: string;
  /** Which path the resolver took. Useful for sdk-trace observability. */
  source: 'in-region-replica' | 'home-region' | 'primary-fallback' | 'no-aa-profile';
}

interface TenantMapRow {
  primary_pool_index: string;
  replica_pool_indexes: Record<string, string> | null;
  active_active_profile_id: string | null;
  home_region: string | null;
}

async function loadTenantMap(tenantId: string): Promise<TenantMapRow | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<TenantMapRow>(
      `SELECT tpm.primary_pool_index,
              tpm.replica_pool_indexes,
              tpm.active_active_profile_id,
              p.home_region
         FROM routing.tenant_pool_map tpm
         LEFT JOIN active_active.profile p
           ON p.profile_id = tpm.active_active_profile_id
        WHERE tpm.tenant_id = $1::uuid`,
      [tenantId],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function resolveReadReplica(input: ResolveReadReplicaInput): Promise<ResolvedReadReplica | null> {
  const row = await loadTenantMap(input.tenant_id);
  if (!row) return null;

  if (!row.active_active_profile_id) {
    return { pool_index: row.primary_pool_index, source: 'no-aa-profile' };
  }

  const map = row.replica_pool_indexes ?? {};
  const replicaForRequest = map[input.request_region];
  if (replicaForRequest) {
    return { pool_index: replicaForRequest, source: 'in-region-replica' };
  }

  if (row.home_region && row.home_region === input.request_region) {
    return { pool_index: row.primary_pool_index, source: 'home-region' };
  }

  return { pool_index: row.primary_pool_index, source: 'primary-fallback' };
}
