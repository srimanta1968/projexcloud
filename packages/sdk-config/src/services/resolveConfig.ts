import { dataService } from '@projexlight/db-runtime';
import type { ConfigContext, ConfigScope, ConfigValueRef } from '../index';
import { SCOPE_PRECEDENCE } from '../index';

/**
 * resolveConfig(key, ctx) — the read hot path of the config plane (EP-341).
 *
 * Walks the scope chain from MOST specific to LEAST specific
 * (app_user -> app -> tenant -> platform) and returns the first ACTIVE row for
 * `key`, so an app-user override beats an app default beats a tenant setting
 * beats the platform default. Every runtime API reads its provider config
 * through this instead of process.env, so config lives in tenant/app context.
 *
 * Cache: a small in-process TTL cache keyed by (key + the resolved scope ids)
 * keeps the hot path off Postgres; writes call invalidateConfig(key) so a
 * set/rotate/revoke is reflected within the TTL at worst. The cache is
 * per-process; multi-replica convergence is bounded by CONFIG_CACHE_TTL_MS.
 */

const CACHE_TTL_MS = parseInt(process.env.CONFIG_CACHE_TTL_MS || '30000', 10);

interface CacheEntry {
  value: ConfigValueRef | null;
  at: number;
}
const cache = new Map<string, CacheEntry>();

function cacheKey(key: string, ctx: ConfigContext): string {
  return [key, ctx.app_user_id ?? '', ctx.app_id ?? '', ctx.tenant_id ?? ''].join('|');
}

/** Candidate (scope, scope_id) pairs for a context, MOST specific first. */
function candidates(ctx: ConfigContext): Array<{ scope: ConfigScope; scope_id: string }> {
  const byScope: Record<ConfigScope, string | null | undefined> = {
    app_user: ctx.app_user_id,
    app: ctx.app_id,
    tenant: ctx.tenant_id,
    platform: '',
  };
  const out: Array<{ scope: ConfigScope; scope_id: string }> = [];
  for (const scope of SCOPE_PRECEDENCE) {
    const id = byScope[scope];
    // platform always applies (scope_id ''); others only when the ctx has an id.
    if (scope === 'platform') out.push({ scope, scope_id: '' });
    else if (id) out.push({ scope, scope_id: id });
  }
  return out;
}

/**
 * Resolve the most-specific active config row for `key` given `ctx`.
 * Returns null when no scope in the chain has an active value.
 */
export async function resolveConfig(key: string, ctx: ConfigContext): Promise<ConfigValueRef | null> {
  const ck = cacheKey(key, ctx);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const cands = candidates(ctx);
  // One query fetches every active row for this key across the candidate
  // (scope, scope_id) pairs; we then pick the most specific in JS by the
  // precedence order the candidates were built in.
  const rows = await dataService.rows<ConfigValueRef>(
    `SELECT config_id, scope, scope_id, key, value, secret_ref, status, set_by, created_at, updated_at
       FROM config.config_value
      WHERE key = $1 AND status = 'active'
        AND (scope, scope_id) IN (${cands.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(', ')})`,
    [key, ...cands.flatMap((c) => [c.scope, c.scope_id])],
  );

  let resolved: ConfigValueRef | null = null;
  for (const cand of cands) {
    const match = rows.find((r) => r.scope === cand.scope && r.scope_id === cand.scope_id);
    if (match) {
      resolved = match;
      break;
    }
  }
  cache.set(ck, { value: resolved, at: Date.now() });
  return resolved;
}

/**
 * Convenience: resolve just the non-secret JSON value for a key (null when
 * unset or when the resolved row is a secret with no inline value).
 */
export async function resolveConfigValue(
  key: string,
  ctx: ConfigContext,
): Promise<Record<string, unknown> | null> {
  const row = await resolveConfig(key, ctx);
  return row?.value ?? null;
}

/** Drop cached entries for a key (all contexts). Call after any write. */
export function invalidateConfig(key: string): void {
  const prefix = key + '|';
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/** Clear the whole resolver cache (tests / bulk import). */
export function clearConfigCache(): void {
  cache.clear();
}
