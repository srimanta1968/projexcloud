import { getPool } from '@projexlight/db-runtime';
import type { ReplicationMode } from '@projexlight/contracts';

/**
 * Active-Active mode-aware routing helpers (G-P8-4).
 *
 * The `withTenant()` primitive in P1 returns a DSN-bound DB handle. P8
 * Variant D layers replication semantics on top WITHOUT changing
 * withTenant's signature — callers that need home-region routing call
 * the helpers here to pick the correct region for the (tenant, sdk_kind)
 * pair.
 *
 * Routing matrix:
 *   - mode='single-region' → always route to profile.home_region (OLTP).
 *   - mode='sync'          → write to home_region; reads can come from any
 *                            paired region (replicas catch up <= rpo_target).
 *   - mode='async'         → write/read to local (request) region; cross-
 *                            region propagation is eventually consistent.
 *
 * Tenants without an active_active profile fall through to the default
 * single-region behavior (no-op).
 */

export type RoutingDecision =
  | { mode: 'single-region'; route_to_region: string; reason: 'oltp-home-region' }
  | { mode: 'sync'; route_to_region: string; reason: 'sync-home-region' }
  | { mode: 'async'; route_to_region: string; reason: 'async-local-region' }
  | { mode: 'none'; route_to_region: string; reason: 'no-aa-profile' };

export interface RoutingContext {
  tenant_id: string;
  sdk_kind: string;
  /** The region the request originated from (gateway-derived). */
  request_region: string;
}

interface ProfileStreamRow {
  home_region: string;
  mode: string | null;
}

async function loadProfileForRouting(tenantId: string, sdkKind: string): Promise<ProfileStreamRow | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<ProfileStreamRow>(
      `SELECT p.home_region, s.mode
         FROM active_active.profile p
         LEFT JOIN active_active.replication_stream s
           ON s.profile_id = p.profile_id AND s.sdk_kind = $2
        WHERE p.tenant_id = $1::uuid
        LIMIT 1`,
      [tenantId, sdkKind],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute the routing decision for a (tenant, sdk_kind) pair.
 *
 * Use this to choose which region's pool to bind via withTenant():
 *
 *   const d = await resolveActiveActiveRouting({ tenant_id, sdk_kind: 'sdk-payment', request_region: 'us-east' });
 *   const pool = await withTenant({ ...ctx, region: d.route_to_region });
 *
 * Callers that don't care about replication can skip this and use
 * withTenant() directly — the result is identical for tenants without
 * an active_active profile.
 */
export async function resolveActiveActiveRouting(ctx: RoutingContext): Promise<RoutingDecision> {
  const profile = await loadProfileForRouting(ctx.tenant_id, ctx.sdk_kind);
  if (!profile) {
    return { mode: 'none', route_to_region: ctx.request_region, reason: 'no-aa-profile' };
  }
  // Missing replication_stream row (left join produced null) defaults to
  // single-region for safety — never silently allow cross-region writes
  // for an unconfigured SDK.
  const mode = (profile.mode ?? 'single-region') as ReplicationMode;
  switch (mode) {
    case 'single-region':
      return { mode, route_to_region: profile.home_region, reason: 'oltp-home-region' };
    case 'sync':
      return { mode, route_to_region: profile.home_region, reason: 'sync-home-region' };
    case 'async':
      return { mode, route_to_region: ctx.request_region, reason: 'async-local-region' };
  }
}

/**
 * Convenience: throw if a write is attempted from a non-home region for a
 * single-region or sync SDK. Use at write entry points to make the policy
 * explicit at the boundary.
 */
export class CrossRegionWriteRejected extends Error {
  readonly code = 'cross_region_write_rejected';
  readonly status_code = 421; // Misdirected Request
  constructor(public readonly decision: RoutingDecision, public readonly attempted_region: string) {
    super(
      `cross-region write rejected for ${decision.mode} SDK: must write to ${decision.route_to_region}, attempted from ${attempted_region}`,
    );
    this.name = 'CrossRegionWriteRejected';
  }
}

export async function assertWriteAllowed(ctx: RoutingContext): Promise<RoutingDecision> {
  const d = await resolveActiveActiveRouting(ctx);
  if ((d.mode === 'single-region' || d.mode === 'sync') && d.route_to_region !== ctx.request_region) {
    throw new CrossRegionWriteRejected(d, ctx.request_region);
  }
  return d;
}
