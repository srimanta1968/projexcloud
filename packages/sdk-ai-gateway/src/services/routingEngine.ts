import { dataService } from '@projexlight/db-runtime';
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
  const r = await dataService.query<RouteRuleRow>(
    `SELECT rule_id, predicate, provider_id, model, priority
       FROM ai_gateway.route_rule
      WHERE tenant_id = $1::uuid
        AND active = TRUE
      ORDER BY priority ASC`,
    [tenant_id],
  );

  for (const row of r.rows) {
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

export async function isCircuitOpen(provider_id: ProviderId): Promise<boolean> {
  const row = await dataService.one<CircuitRow>(
    `SELECT circuit_state, failure_streak, last_failure_at
       FROM ai_gateway.provider WHERE provider_id = $1`,
    [provider_id],
  );
  if (!row) return false;
  if (row.circuit_state === 'closed') return false;
  if (row.circuit_state === 'open' && row.last_failure_at) {
    const cooledDown = Date.now() - row.last_failure_at.getTime() > CIRCUIT_COOLDOWN_MS;
    if (cooledDown) {
      await dataService.query(
        `UPDATE ai_gateway.provider SET circuit_state = 'half-open' WHERE provider_id = $1`,
        [provider_id],
      );
      return false;
    }
    return true;
  }
  return false;
}

export async function recordProviderSuccess(provider_id: ProviderId): Promise<void> {
  await dataService.query(
    `UPDATE ai_gateway.provider
        SET circuit_state = 'closed',
            failure_streak = 0,
            last_failure_at = NULL
      WHERE provider_id = $1`,
    [provider_id],
  );
}

export async function recordProviderFailure(provider_id: ProviderId): Promise<void> {
  const r = await dataService.one<{ failure_streak: number }>(
    `UPDATE ai_gateway.provider
        SET failure_streak = failure_streak + 1,
            last_failure_at = now(),
            circuit_state = CASE
              WHEN failure_streak + 1 >= $2 THEN 'open'
              ELSE circuit_state
            END
      WHERE provider_id = $1
     RETURNING failure_streak`,
    [provider_id, CIRCUIT_OPEN_THRESHOLD],
  );
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
      const expDelay = Math.min(cap, base * Math.pow(2, attempt));
      const jitter = Math.random() * expDelay * 0.2;
      await new Promise((r) => setTimeout(r, expDelay + jitter));
    }
  }
  throw lastErr;
}
