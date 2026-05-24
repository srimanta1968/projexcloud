/**
 * Federation router — stateless route resolver.
 *
 * Public surface kept minimal for this initial drop:
 *   - resolveRoute(federation_id, query_class) returns the persisted
 *     execution plan + target pool indexes for a sanctioned cross-pool
 *     case, cached in Redis (fed:route:{fed}:{class} TTL 60s).
 *   - recordFailover(...) writes a federation.failover_event row.
 *
 * Full chaos-drill orchestration + auto-failover decision-tree live in
 * follow-up tasks under feat_p7_federation (TK-3367 +).
 *
 * NFR (PRD §6 + AC-6): routing decision ≤ 5ms p99. The Redis hit path
 * comfortably hits that; the cold path is one indexed Postgres lookup.
 */

import { getPool } from '@projexlight/db-runtime';
import type {
  FederationRouteRef,
  FederationFailoverEventRef,
  FederationQueryClass,
  FederationFailoverTrigger,
} from '@projexlight/contracts';

/** Redis-style cache surface. Pluggable so tests can pass an in-memory stub. */
export interface RouteCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface ResolveRouteOptions {
  cache?: RouteCache;
  /** When true, bypass cache (read-through). Useful after a manifest change. */
  bypassCache?: boolean;
  /** Caller's region — used by the sovereign isolation check (G-P8-7). */
  request_region?: string;
}

/**
 * SovereignIsolationError — thrown when a cross-region route would touch a
 * sovereign region with terminal_federation=true (FR-SOV-2). The federation
 * runtime refuses these by design; the route exists in the DB but the
 * sovereign policy preempts the routing decision.
 */
export class SovereignIsolationError extends Error {
  readonly code = 'sovereign_isolation';
  readonly status_code = 451; // Unavailable For Legal Reasons
  constructor(
    public readonly federation_id: string,
    public readonly request_region: string,
    public readonly blocked_regions: string[],
  ) {
    super(
      `route from ${request_region} blocked by sovereign isolation in regions: ${blocked_regions.join(', ')}`,
    );
    this.name = 'SovereignIsolationError';
  }
}

/**
 * Check whether any of the target pool indexes resolve to a sovereign region
 * marked terminal. Returns the list of blocking regions (empty when clear).
 *
 * Logical join via routing.pool.region → sovereign.region_config; both are
 * guarded against missing schemas (sovereign may not be installed in a
 * cloud-only deploy).
 */
async function blockingSovereignRegions(targetPoolIndexes: string[], requestRegion: string): Promise<string[]> {
  if (targetPoolIndexes.length === 0) return [];
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ region: string }>(
      `SELECT DISTINCT p.region
         FROM routing.pool p
         JOIN sovereign.region_config s
           ON s.region_id = p.region
        WHERE p.pool_index = ANY($1::text[])
          AND s.terminal_federation = TRUE
          AND p.region <> $2`,
      [targetPoolIndexes, requestRegion],
    );
    return rows.map((r) => r.region);
  } catch {
    // sovereign schema not installed → no sovereign blocking (cloud-only deploy).
    return [];
  }
}

function routeKey(federationId: string, queryClass: FederationQueryClass): string {
  return `fed:route:${federationId}:${queryClass}`;
}

/**
 * Resolve a sanctioned cross-pool route. Returns null when no row is
 * registered — callers must treat that as a hard fail (the federation
 * runtime refuses unsanctioned cross-pool reads per OC-5).
 */
export async function resolveRoute(
  federationId: string,
  queryClass: FederationQueryClass,
  opts: ResolveRouteOptions = {},
): Promise<FederationRouteRef | null> {
  const cache = opts.cache;
  const key = routeKey(federationId, queryClass);

  if (cache && !opts.bypassCache) {
    const cached = await cache.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as FederationRouteRef;
      } catch {
        // Bad cache entry — fall through to Postgres.
      }
    }
  }

  const pool = getPool();
  const { rows } = await pool.query<{
    route_id: string;
    federation_id: string;
    query_class: FederationQueryClass;
    target_pool_indexes: string[];
    execution_plan: Record<string, unknown>;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT route_id, federation_id, query_class, target_pool_indexes,
            execution_plan, created_at, last_used_at
       FROM federation.route
      WHERE federation_id = $1 AND query_class = $2
      LIMIT 1`,
    [federationId, queryClass],
  );
  if (rows.length === 0) return null;

  const row = rows[0];

  // P8 FR-SOV-2 / G-P8-7: refuse cross-region routes that touch a sovereign
  // region with terminal_federation=true. The route row exists in the DB
  // (a P7 federation could have planned it), but the sovereign policy
  // preempts; this is the "treat as terminal" enforcement.
  if (opts.request_region) {
    const blocked = await blockingSovereignRegions(row.target_pool_indexes, opts.request_region);
    if (blocked.length > 0) {
      throw new SovereignIsolationError(federationId, opts.request_region, blocked);
    }
  }

  const ref: FederationRouteRef = {
    route_id: row.route_id,
    federation_id: row.federation_id,
    query_class: row.query_class,
    target_pool_indexes: row.target_pool_indexes,
    execution_plan: row.execution_plan,
    created_at: row.created_at.toISOString(),
    last_used_at: row.last_used_at?.toISOString() ?? null,
  };

  // Touch last_used_at without blocking the hot path.
  void pool.query(`UPDATE federation.route SET last_used_at = now() WHERE route_id = $1`, [row.route_id]);

  if (cache) {
    void cache.set(key, JSON.stringify(ref), 60);
  }
  return ref;
}

/** Record a failover event (chaos drill, production failover, operator). */
export async function recordFailover(input: {
  event_id: string;
  federation_id: string;
  from_region: string;
  to_region: string;
  trigger: FederationFailoverTrigger;
  rpo_observed: number;
  rto_observed: number;
}): Promise<FederationFailoverEventRef> {
  const pool = getPool();
  const { rows } = await pool.query<{ occurred_at: Date }>(
    `INSERT INTO federation.failover_event
       (event_id, federation_id, from_region, to_region, trigger,
        rpo_observed, rto_observed)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING occurred_at`,
    [
      input.event_id,
      input.federation_id,
      input.from_region,
      input.to_region,
      input.trigger,
      input.rpo_observed,
      input.rto_observed,
    ],
  );
  return { ...input, occurred_at: rows[0].occurred_at.toISOString() };
}
