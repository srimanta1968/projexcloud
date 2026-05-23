/**
 * Per-(tenant, sku, period) usage counter — Redis-backed.
 *
 * Why this exists:
 *   The soft-cap gate (FR-MET soft-cap mode) runs on the hot path of every
 *   metered request. The naive Postgres aggregator (`SUM(units) FROM
 *   meter.usage_event WHERE ...`) is O(rows-this-month) per call — at
 *   1k req/s that's 1k full-table-scan-equivalent queries against the
 *   biggest table in the system.
 *
 *   This counter swaps that O(rows) read for an O(1) Redis GET on the
 *   gate-check path, and an O(1) INCRBY on the report() path. Postgres
 *   stays the durable source of truth via meter.usage_event; the counter
 *   is a cache the audit chain verifier can recompute from scratch on
 *   demand (so divergence is detectable + correctable, not silent).
 *
 * Keys: usage:{period_key}:{tenant_id}:{sku}
 *   period_key defaults to YYYY-MM (calendar-month rollover). TTL is set to
 *   ~32 days so the previous month's key auto-expires.
 *
 * Lazy-init: getCounter() returns null when Redis isn't configured; callers
 * fall back to the Postgres aggregator. This makes the package safe to
 * import in tests and dev environments without Redis.
 */

import { getRedis } from '@projexlight/redis-runtime';

export interface UsageCounter {
  incr(tenant_id: string, sku: string, by: number): Promise<void>;
  get(tenant_id: string, sku: string): Promise<number>;
  /** Reset for testing only — production never calls this. */
  reset(tenant_id: string, sku: string): Promise<void>;
}

const PERIOD_TTL_SECONDS = 32 * 24 * 3600; // ~32d so previous-month keys roll off

function periodKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function key(tenant_id: string, sku: string, now: Date = new Date()): string {
  return `usage:${periodKey(now)}:${tenant_id}:${sku}`;
}

class RedisUsageCounter implements UsageCounter {
  async incr(tenant_id: string, sku: string, by: number): Promise<void> {
    if (by <= 0) return;
    const k = key(tenant_id, sku);
    const client = getRedis();
    // Pipeline INCRBYFLOAT + EXPIRE — single round-trip.
    const pipeline = client.multi();
    pipeline.incrbyfloat(k, by);
    pipeline.expire(k, PERIOD_TTL_SECONDS);
    await pipeline.exec();
  }
  async get(tenant_id: string, sku: string): Promise<number> {
    const raw = await getRedis().get(key(tenant_id, sku));
    return raw ? Number(raw) : 0;
  }
  async reset(tenant_id: string, sku: string): Promise<void> {
    await getRedis().del(key(tenant_id, sku));
  }
}

let _counter: UsageCounter | null = null;

/**
 * Install the Redis-backed counter. Call once at boot AFTER initRedis().
 * Safe to skip — sdk-meter falls back to whichever
 * registerCurrentUsageResolver the gateway wired (typically a Postgres
 * SUM aggregator).
 */
export function installRedisUsageCounter(): UsageCounter {
  _counter = new RedisUsageCounter();
  return _counter;
}

/** Custom counter (in-memory for tests, alternate backend for niche deploys). */
export function registerUsageCounter(counter: UsageCounter): void {
  _counter = counter;
}

export function getUsageCounter(): UsageCounter | null {
  return _counter;
}

/**
 * In-memory counter for unit tests. Resets per process — never use in prod.
 */
export class InMemoryUsageCounter implements UsageCounter {
  private readonly store = new Map<string, number>();
  async incr(tenant_id: string, sku: string, by: number): Promise<void> {
    const k = key(tenant_id, sku);
    this.store.set(k, (this.store.get(k) ?? 0) + by);
  }
  async get(tenant_id: string, sku: string): Promise<number> {
    return this.store.get(key(tenant_id, sku)) ?? 0;
  }
  async reset(tenant_id: string, sku: string): Promise<void> {
    this.store.delete(key(tenant_id, sku));
  }
}
