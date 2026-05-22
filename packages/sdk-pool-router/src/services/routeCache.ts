import type { ResolveResult } from './poolRegistry';

export interface RouteCache {
  get(tenant_id: string, app_id: string): Promise<ResolveResult | null>;
  set(tenant_id: string, app_id: string, value: ResolveResult, ttlMs: number): Promise<void>;
  invalidatePool(pool_index: string): Promise<void>;
  clear(): Promise<void>;
}

interface Entry {
  value: ResolveResult;
  expires_at: number;
}

/**
 * In-memory route cache for the prototype. Sub-ms lookup. Production
 * replaces this via setCache() with a Redis adapter that also subscribes to
 * the `pool:status-flip` pub/sub channel for cross-service invalidation
 * (FR-PR-4).
 */
export class InMemoryRouteCache implements RouteCache {
  private readonly store: Map<string, Entry> = new Map();

  private keyFor(tenant_id: string, app_id: string): string {
    return `${tenant_id}|${app_id}`;
  }

  async get(tenant_id: string, app_id: string): Promise<ResolveResult | null> {
    const entry = this.store.get(this.keyFor(tenant_id, app_id));
    if (!entry) return null;
    if (entry.expires_at < Date.now()) {
      this.store.delete(this.keyFor(tenant_id, app_id));
      return null;
    }
    return entry.value;
  }

  async set(tenant_id: string, app_id: string, value: ResolveResult, ttlMs: number): Promise<void> {
    this.store.set(this.keyFor(tenant_id, app_id), {
      value,
      expires_at: Date.now() + ttlMs,
    });
  }

  async invalidatePool(pool_index: string): Promise<void> {
    for (const [key, entry] of this.store.entries()) {
      if (entry.value.pool_index === pool_index) {
        this.store.delete(key);
      }
    }
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

let _cache: RouteCache = new InMemoryRouteCache();
let _ttlMs: number = 300_000;

/**
 * Installs the active cache adapter. Production wires this to a Redis-backed
 * implementation at api-gateway startup.
 */
export function setCache(cache: RouteCache, ttlMs?: number): void {
  _cache = cache;
  if (ttlMs !== undefined) _ttlMs = ttlMs;
}

export function getCache(): RouteCache {
  return _cache;
}

export function getDefaultTtlMs(): number {
  return _ttlMs;
}
