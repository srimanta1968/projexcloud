import { dataService, getPool } from '@projexlight/db-runtime';
import type { ProviderId, CompletionRequest } from '@projexlight/contracts';

/**
 * Per-tenant routing rule resolver + circuit breaker (FR-AGW-2, FR-AGW-9).
 *
 * Resolves which (provider, model) to use for a given CompletionRequest by
 * matching the request's task_tag (or other predicate keys) against the
 * tenant's active route_rule rows in `ai_gateway.route_rule`.
 *
 * The circuit breaker tracks consecutive failures per provider and flips
 * state closed → half-open (after cooldown) → open. The completion path
 * skips providers with open circuits and falls back to the next-priority
 * rule.
 */

const CIRCUIT_OPEN_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;

export interface RouteDecision {
  rule_id: string;
  provider_id: ProviderId;
  model: string;
  priority: number;
}

interface RouteRuleRow {
  rule_id: string;
  predicate: Record<string, unknown>;
  provider_id: ProviderId;
  model: string;
  priority: number;
}

function predicateMatches(
  predicate: Record<string, unknown>,
  request: CompletionRequest,
): boolean {
  if (!predicate || Object.keys(predicate).length === 0) return true;
  for (const [key, expected] of Object.entries(predicate)) {
    if (key === 'task_tag') {
      if (request.task_tag !== expected) return false;
    } else if (key === 'model') {
      if (request.model !== expected) return false;
    } else if (key === 'provider_hint') {
      if (request.provider_hint !== expected) return false;
    }
    // Unknown predicate keys are treated as non-match — stricter is safer.
    else {
      return false;
    }
  }
  return true;
}

/* ------------------------- route-rule cache (TK-4495) ------------------------- */

/**
 * Hot-path cache of each tenant's active route rules (VA·E5). A warm resolution reads
 * only process memory. Entries expire after AI_GATEWAY_ROUTE_CACHE_TTL_MS (default and
 * maximum 60 s) and are dropped immediately when the table announces a change for the
 * tenant (migration 004's trigger -> pg_notify -> startRouteRuleListener). A tenant with
 * no rules is cached too, so the common "no rules, use provider_hint" path stays warm.
 */
const MAX_ROUTE_TTL_MS = 60_000;
const routeTtlMs = (): number => Math.min(Number(process.env.AI_GATEWAY_ROUTE_CACHE_TTL_MS ?? MAX_ROUTE_TTL_MS), MAX_ROUTE_TTL_MS);
const routeCache = new Map<string, { rows: RouteRuleRow[]; loadedAt: number }>();
const routeStats = { hits: 0, misses: 0, invalidations: 0 };

async function loadRules(tenant_id: string): Promise<RouteRuleRow[]> {
  const hit = routeCache.get(tenant_id);
  if (hit && Date.now() - hit.loadedAt < routeTtlMs()) {
    routeStats.hits += 1;
    return hit.rows;
  }
  routeStats.misses += 1;
  const r = await dataService.query<RouteRuleRow>(
    `SELECT rule_id, predicate, provider_id, model, priority
       FROM ai_gateway.route_rule
      WHERE tenant_id = $1::uuid
        AND active = TRUE
      ORDER BY priority ASC`,
    [tenant_id],
  );
  routeCache.set(tenant_id, { rows: r.rows, loadedAt: Date.now() });
  return r.rows;
}

/** Drops cached route rules for one tenant, or for every tenant when omitted. */
export function invalidateRouteRules(tenant_id?: string): void {
  routeStats.invalidations += 1;
  if (tenant_id) routeCache.delete(tenant_id);
  else routeCache.clear();
}

/** Cache counters (tests and diagnostics). */
export function routeCacheStats(): { hits: number; misses: number; invalidations: number; tenants: number } {
  return { ...routeStats, tenants: routeCache.size };
}

let listenerStarted = false;

/**
 * Listens for route-rule change notifications on a dedicated connection and invalidates
 * the affected tenant. On connection loss it clears the whole cache (notifications may
 * have been missed) and reconnects with backoff. Idempotent.
 */
export function startRouteRuleListener(pool_index?: string): void {
  if (listenerStarted) return;
  listenerStarted = true;
  let delay = 1_000;
  const connect = async (): Promise<void> => {
    try {
      const client = await getPool(pool_index).connect();
      const reconnect = (): void => {
        client.removeAllListeners();
        try { client.release(true); } catch { /* already gone */ }
        invalidateRouteRules();
        setTimeout(() => { void connect(); }, delay);
        delay = Math.min(delay * 2, 30_000);
      };
      client.on('notification', (msg: { channel: string; payload?: string }) => {
        if (msg.channel === 'ai_gateway_route_rule') invalidateRouteRules(msg.payload || undefined);
      });
      client.on('error', reconnect);
      client.on('end', reconnect);
      await client.query('LISTEN ai_gateway_route_rule');
      delay = 1_000;
    } catch (err) {
      console.warn('[routing-engine] route-rule listener unavailable, relying on the TTL:', (err as Error).message);
      setTimeout(() => { void connect(); }, delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };
  void connect();
}

/**
 * Returns the highest-priority matching route for the request, skipping
 * any provider whose circuit is currently open. Returns null when no
 * rule matches — caller falls back to request.provider_hint or errors.
 */
export async function resolveRoute(
  tenant_id: string | null,
  request: CompletionRequest,
): Promise<RouteDecision | null> {
  if (!tenant_id) return null;
  const rows = await loadRules(tenant_id);

  for (const row of rows) {
    if (!predicateMatches(row.predicate, request)) continue;
    const breakerOpen = await isCircuitOpen(row.provider_id);
    if (breakerOpen) continue;
    return {
      rule_id: row.rule_id,
      provider_id: row.provider_id,
      model: row.model,
      priority: row.priority,
    };
  }
  return null;
}

/* ----------------------------- circuit breaker ----------------------------- */

interface CircuitRow {
  circuit_state: 'closed' | 'half-open' | 'open';
  failure_streak: number;
  last_failure_at: Date | null;
}

/**
 * Circuit state is read from ai_gateway.provider but cached per provider for
 * AI_GATEWAY_CIRCUIT_CACHE_MS (default 5 s), so a warm route resolution does not query it.
 * This process's own success/failure updates refresh the cache immediately; other
 * instances' changes are seen within the cache window.
 */
const circuitCacheMs = (): number => Number(process.env.AI_GATEWAY_CIRCUIT_CACHE_MS ?? 5_000);
const circuitCache = new Map<string, { row: CircuitRow | null; loadedAt: number }>();

async function circuitRow(provider_id: ProviderId): Promise<CircuitRow | null> {
  const hit = circuitCache.get(provider_id);
  if (hit && Date.now() - hit.loadedAt < circuitCacheMs()) return hit.row;
  const row = await dataService.one<CircuitRow>(
    `SELECT circuit_state, failure_streak, last_failure_at
       FROM ai_gateway.provider WHERE provider_id = $1`,
    [provider_id],
  );
  circuitCache.set(provider_id, { row, loadedAt: Date.now() });
  return row;
}

export async function isCircuitOpen(provider_id: ProviderId): Promise<boolean> {
  const row = await circuitRow(provider_id);
  if (!row) return false;
  if (row.circuit_state === 'closed') return false;
  if (row.circuit_state === 'open' && row.last_failure_at) {
    const cooledDown = Date.now() - row.last_failure_at.getTime() > CIRCUIT_COOLDOWN_MS;
    if (cooledDown) {
      await dataService.query(
        `UPDATE ai_gateway.provider SET circuit_state = 'half-open' WHERE provider_id = $1`,
        [provider_id],
      );
      circuitCache.set(provider_id, { row: { ...row, circuit_state: 'half-open' }, loadedAt: Date.now() });
      return false;
    }
    return true;
  }
  return false;
}

export async function recordProviderSuccess(provider_id: ProviderId): Promise<void> {
  // Already closed with no failures (as far as the fresh cache knows): nothing to write.
  const hit = circuitCache.get(provider_id);
  if (hit?.row && hit.row.circuit_state === 'closed' && hit.row.failure_streak === 0 && Date.now() - hit.loadedAt < circuitCacheMs()) return;
  await dataService.query(
    `UPDATE ai_gateway.provider
        SET circuit_state = 'closed',
            failure_streak = 0,
            last_failure_at = NULL
      WHERE provider_id = $1`,
    [provider_id],
  );
  circuitCache.set(provider_id, { row: { circuit_state: 'closed', failure_streak: 0, last_failure_at: null }, loadedAt: Date.now() });
}

export async function recordProviderFailure(provider_id: ProviderId): Promise<void> {
  const r = await dataService.one<CircuitRow>(
    `UPDATE ai_gateway.provider
        SET failure_streak = failure_streak + 1,
            last_failure_at = now(),
            circuit_state = CASE
              WHEN failure_streak + 1 >= $2 THEN 'open'
              ELSE circuit_state
            END
      WHERE provider_id = $1
     RETURNING circuit_state, failure_streak, last_failure_at`,
    [provider_id, CIRCUIT_OPEN_THRESHOLD],
  );
  circuitCache.set(provider_id, { row: r, loadedAt: Date.now() });
  if (!r) {
    console.warn('[routing-engine] provider row missing for', provider_id);
  }
}

/* ----------------------------- retry wrapper ----------------------------- */

export interface RetryOptions {
  max_attempts?: number;
  base_delay_ms?: number;
  max_delay_ms?: number;
}

/**
 * Exponential backoff with jitter (FR-AGW-9). Used by the completion
 * service to wrap provider calls. Does not handle circuit breaking —
 * that's the caller's concern (it picks the next route on open circuit).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.max_attempts ?? 3;
  const base = opts.base_delay_ms ?? 200;
  const cap = opts.max_delay_ms ?? 2000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) break;
      // A provider error that cannot succeed on retry (bad key, bad request) fails fast.
      if ((err as { retryable?: boolean } | null)?.retryable === false) break;
      const expDelay = Math.min(cap, base * Math.pow(2, attempt));
      const jitter = Math.random() * expDelay * 0.2;
      await new Promise((r) => setTimeout(r, expDelay + jitter));
    }
  }
  throw lastErr;
}
