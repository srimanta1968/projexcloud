import { getRedis } from '@projexlight/redis-runtime';

/**
 * Per-key request throttling.
 *
 * `rate_limit_rpm` has been accepted by the validator and written to the row
 * since the SDK shipped, and enforced nowhere. An operator who sets a limit and
 * does not get one is worse off than an operator offered no limit at all: they
 * believe they hold a control they do not have, and size their integration
 * accordingly.
 *
 * Fixed window rather than sliding: it is one INCR plus one EXPIRE, the reset
 * instant is exactly representable in the RateLimit-Reset header a client is
 * expected to obey, and the failure mode (a burst spanning a boundary) is
 * bounded at twice the limit — acceptable for a fairness control, which this
 * is. A sliding window would cost a sorted set per key on the hot path to
 * tighten a bound nobody is relying on.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds at which the current window resets. */
  resetAt: number;
  retryAfterSeconds: number;
}

/** Ceiling across all of a tenant's keys, so one application cannot starve the rest. */
function tenantCeiling(): number | null {
  const raw = Number(process.env.API_KEY_TENANT_RPM_CEILING || 0);
  return raw > 0 ? raw : null;
}

function windowStart(now: number): number {
  return Math.floor(now / 60_000) * 60_000;
}

/**
 * Counts this request against the key's limit.
 *
 * Returns `allowed: true` with `limit: 0` when no limit applies — an unlimited
 * key is the default and must not pay for a Redis round trip.
 */
export async function consume(
  key_id: string,
  rate_limit_rpm: number | null,
  tenant_id?: string,
): Promise<RateLimitDecision> {
  const now = Date.now();
  const start = windowStart(now);
  const resetAt = Math.floor((start + 60_000) / 1000);
  const unlimited: RateLimitDecision = {
    allowed: true,
    limit: 0,
    remaining: 0,
    resetAt,
    retryAfterSeconds: 0,
  };

  const ceiling = tenantCeiling();
  if (!rate_limit_rpm && !ceiling) return unlimited;

  let redis;
  try {
    redis = getRedis();
  } catch {
    // No Redis: DO NOT fail closed. A counter outage that 429s every machine
    // caller would turn a telemetry dependency into a platform-wide outage —
    // strictly worse than briefly not enforcing a fairness limit.
    return unlimited;
  }

  try {
    if (rate_limit_rpm) {
      const decision = await hit(redis, `ratelimit:key:${key_id}:${start}`, rate_limit_rpm, resetAt, now);
      if (!decision.allowed) return decision;
      if (!ceiling || !tenant_id) return decision;
      const tenantDecision = await hit(
        redis,
        `ratelimit:tenant:${tenant_id}:${start}`,
        ceiling,
        resetAt,
        now,
      );
      // Report the binding constraint, whichever it is, so the headers a client
      // reads describe the limit that actually stopped it.
      return tenantDecision.allowed ? decision : tenantDecision;
    }
    return await hit(redis, `ratelimit:tenant:${tenant_id}:${start}`, ceiling as number, resetAt, now);
  } catch {
    return unlimited;
  }
}

async function hit(
  redis: ReturnType<typeof getRedis>,
  redisKey: string,
  limit: number,
  resetAt: number,
  now: number,
): Promise<RateLimitDecision> {
  const count = await redis.incr(redisKey);
  if (count === 1) {
    // Expire slightly beyond the window so a clock skew between replicas cannot
    // drop a counter that is still being written to.
    await redis.expire(redisKey, 120);
  }
  const allowed = count <= limit;
  return {
    allowed,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, resetAt - Math.floor(now / 1000)),
  };
}

/** IETF draft-style headers, the set every mainstream HTTP client understands. */
export function rateLimitHeaders(d: RateLimitDecision): Record<string, string> {
  if (d.limit === 0) return {};
  const headers: Record<string, string> = {
    'RateLimit-Limit': String(d.limit),
    'RateLimit-Remaining': String(d.remaining),
    'RateLimit-Reset': String(d.resetAt),
  };
  if (!d.allowed) headers['Retry-After'] = String(d.retryAfterSeconds);
  return headers;
}
