/**
 * Per-tenant token bucket. In-process for the MVP; in real prod the
 * counter belongs in Redis so a pool of replicas shares one limit.
 */
export interface RateLimiter {
  check(tenantKey: string): { ok: boolean; remaining: number };
}

export function createInProcessRateLimiter(perMin: number): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return {
    check(tenantKey: string) {
      const now = Date.now();
      const b = buckets.get(tenantKey);
      if (!b || b.resetAt <= now) {
        buckets.set(tenantKey, { count: 1, resetAt: now + 60_000 });
        return { ok: true, remaining: perMin - 1 };
      }
      if (b.count >= perMin) return { ok: false, remaining: 0 };
      b.count += 1;
      return { ok: true, remaining: perMin - b.count };
    },
  };
}
