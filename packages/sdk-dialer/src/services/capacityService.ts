import { dataService } from '@projexlight/db-runtime';
import { getRedis } from '@projexlight/redis-runtime';

/**
 * Effective concurrency caps (VA·E5 · TK-4484).
 *
 * A call occupies a SLOT from the moment it is handed to the carrier until it ends. A
 * tenant may never hold more slots than
 *
 *     min(plan cap, telephony-key capacity, campaign cap)
 *
 * — the plan's concurrent-call entitlement, what the tenant's carrier key can carry, and
 * the campaign's own max_concurrency (API calls have no campaign dimension).
 *
 * Primary store: Redis sorted sets, one per dimension (tenant, key, campaign), member =
 * call_id, score = lease expiry. A Lua script prunes expired members, checks every
 * dimension and adds the call to all of them in ONE atomic step, so two dispatchers can
 * never both take the last slot. The per-member expiry is the "TTL": a slot leaked by a
 * crashed runtime frees itself when its lease lapses instead of shrinking capacity for
 * ever, which a plain INCR/DECR counter would.
 *
 * Fallback when Redis is not initialised: the same decision counted exactly in Postgres
 * (calls in dialing / ringing / in_progress) under a per-tenant advisory lock. Slower,
 * but it FAILS SAFE — capacity is a carrier/contract limit, so unlike a rate limiter it
 * is never simply skipped when the counter store is down.
 */

export type CapDimension = 'plan' | 'key' | 'campaign';

export interface SlotRequest {
  tenant_id: string;
  call_id: string;
  campaign_id: string | null;
  agent_id: string;
  /**
   * Inbound calls are admitted against the FULL plan/key cap; outbound dispatch stops
   * short of it by the inbound reserve (TK-4485), so a burst of outbound campaign calls
   * can never leave no room for a customer calling in.
   */
  direction?: 'inbound' | 'outbound';
}

export interface SlotDecision {
  granted: boolean;
  /** The dimension that was full, when not granted. */
  blocked_by: CapDimension | null;
  caps: Record<CapDimension, number | null>;
  key_ref: string;
  backend: 'redis' | 'postgres';
}

/** Plan-level concurrent-call cap for a tenant; null = unlimited. */
export type PlanCapResolver = (tenantId: string) => Promise<number | null>;
/** Concurrent-call capacity of a tenant's telephony key; null = unlimited. */
export type KeyCapacityResolver = (tenantId: string, keyRef: string) => Promise<number | null>;

const ACTIVE_STATUSES = ['dialing', 'ringing', 'in_progress'];
/** Share of the plan/key cap held back from outbound dispatch for inbound calls. */
const INBOUND_RESERVE_PCT = Number(process.env.DIALER_INBOUND_RESERVE_PCT ?? 10);

/** The cap outbound dispatch may fill: cap minus the inbound reserve (floor, never negative). */
export function outboundCap(cap: number | null): number | null {
  if (cap === null) return null;
  return Math.max(0, cap - Math.floor((cap * INBOUND_RESERVE_PCT) / 100));
}
const LEASE_MS = Number(process.env.DIALER_SLOT_LEASE_MS || 2 * 60 * 60 * 1000);

const envCap = (name: string): number | null => {
  const v = process.env[name];
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

let planCapResolver: PlanCapResolver = async () => envCap('DIALER_DEFAULT_PLAN_CONCURRENCY') ?? 10;
let keyCapacityResolver: KeyCapacityResolver = async () => envCap('DIALER_DEFAULT_KEY_CAPACITY');

/** Installs the plan-cap source (sdk-billing entitlement, TK-4504). */
export function setPlanCapResolver(fn: PlanCapResolver): void {
  planCapResolver = fn;
}

/** Installs the telephony-key capacity source (tenant credential capacity, TK-4497). */
export function setKeyCapacityResolver(fn: KeyCapacityResolver): void {
  keyCapacityResolver = fn;
}

/** Which telephony key a call will use: the agent's published stack profile's telephony credential. */
async function keyRefFor(tenantId: string, agentId: string): Promise<string> {
  const row = await dataService.one<{ ref: string | null }>(
    `SELECT sp.credential_refs -> 'telephony' ->> 'primary' AS ref
       FROM voice_agent.agent a
       JOIN voice_agent.agent_version v ON v.version_id = a.published_version_id AND v.tenant_id = a.tenant_id
       JOIN voice_agent.stack_profile sp ON sp.profile_id = v.stack_profile_id AND sp.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.agent_id = $2`,
    [tenantId, agentId],
  );
  return row?.ref ?? 'platform';
}

async function capsFor(req: SlotRequest, keyRef: string): Promise<Record<CapDimension, number | null>> {
  const full = await fullCapsFor(req, keyRef);
  if (req.direction === 'inbound') return full;
  return { plan: outboundCap(full.plan), key: outboundCap(full.key), campaign: full.campaign };
}

async function fullCapsFor(req: SlotRequest, keyRef: string): Promise<Record<CapDimension, number | null>> {
  const campaign = req.campaign_id
    ? await dataService.one<{ max_concurrency: number }>(
      `SELECT max_concurrency FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`,
      [req.tenant_id, req.campaign_id],
    )
    : null;
  return {
    plan: await planCapResolver(req.tenant_id),
    key: await keyCapacityResolver(req.tenant_id, keyRef),
    campaign: campaign ? campaign.max_concurrency : null,
  };
}

const redisKeys = (req: SlotRequest, keyRef: string): Record<CapDimension, string | null> => ({
  plan: `dialer:active:tenant:${req.tenant_id}`,
  key: `dialer:active:key:${req.tenant_id}:${keyRef}`,
  campaign: req.campaign_id ? `dialer:active:campaign:${req.campaign_id}` : null,
});

/**
 * KEYS = dimension sets; ARGV = now, expiry, call_id, then one cap per key (-1 = unlimited).
 * Returns {1, 0} when granted, {0, i} when KEYS[i] was full. Re-acquiring a call that
 * already holds its slot is a no-op success (it is already a member).
 */
const ACQUIRE_LUA = `
local now, expiry, member = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3]
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  local cap = tonumber(ARGV[3 + i])
  if cap >= 0 and redis.call('ZSCORE', KEYS[i], member) == false and redis.call('ZCARD', KEYS[i]) >= cap then
    return {0, i}
  end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], expiry, member)
  redis.call('PEXPIREAT', KEYS[i], expiry)
end
return {1, 0}`;

function redisOrNull(): ReturnType<typeof getRedis> | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/** Takes one concurrency slot for a call, or reports which cap is full. */
export async function acquireSlot(req: SlotRequest): Promise<SlotDecision> {
  const keyRef = await keyRefFor(req.tenant_id, req.agent_id);
  const caps = await capsFor(req, keyRef);
  const redis = redisOrNull();
  if (redis) {
    const keys = redisKeys(req, keyRef);
    const dims = (Object.keys(keys) as CapDimension[]).filter((d) => keys[d] !== null);
    const now = Date.now();
    const res = (await redis.eval(
      ACQUIRE_LUA, dims.length, ...dims.map((d) => keys[d] as string),
      String(now), String(now + LEASE_MS), req.call_id, ...dims.map((d) => String(caps[d] ?? -1)),
    )) as [number, number];
    if (res[0] === 1) {
      await redis.set(`dialer:lease:${req.call_id}`, JSON.stringify(dims.map((d) => keys[d])), 'PX', LEASE_MS);
      return { granted: true, blocked_by: null, caps, key_ref: keyRef, backend: 'redis' };
    }
    return { granted: false, blocked_by: dims[res[1] - 1], caps, key_ref: keyRef, backend: 'redis' };
  }
  return acquireInPostgres(req, keyRef, caps);
}

async function acquireInPostgres(req: SlotRequest, keyRef: string, caps: Record<CapDimension, number | null>): Promise<SlotDecision> {
  return dataService.tx(async (q) => {
    // Serialise acquisitions per tenant so two dispatchers cannot both see the last slot free.
    await q(`SELECT pg_advisory_xact_lock(hashtext('dialer.capacity:' || $1))`, [req.tenant_id]);
    const counts = await q<{ tenant_n: number; campaign_n: number }>(
      `SELECT count(*)::int AS tenant_n,
              count(*) FILTER (WHERE q.campaign_id = $3::uuid)::int AS campaign_n
         FROM voice_agent.call c
         LEFT JOIN dialer.dispatch_queue q ON q.call_id = c.call_id
        WHERE c.tenant_id = $1 AND c.status = ANY($2::text[]) AND c.call_id <> $4::uuid`,
      [req.tenant_id, ACTIVE_STATUSES, req.campaign_id, req.call_id],
    );
    const { tenant_n, campaign_n } = counts.rows[0];
    const blocked: CapDimension | null =
      caps.plan !== null && tenant_n >= caps.plan ? 'plan'
        // Without Redis the key dimension is counted at tenant level: every tenant call
        // uses the tenant's key unless its agents map to different ones.
        : caps.key !== null && tenant_n >= caps.key ? 'key'
          : caps.campaign !== null && req.campaign_id && campaign_n >= caps.campaign ? 'campaign'
            : null;
    if (blocked) return { granted: false, blocked_by: blocked, caps, key_ref: keyRef, backend: 'postgres' as const };
    // The slot IS the status change: the call now counts as active.
    await q(
      `UPDATE voice_agent.call SET status = 'dialing', started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND call_id = $2`,
      [req.tenant_id, req.call_id],
    );
    return { granted: true, blocked_by: null, caps, key_ref: keyRef, backend: 'postgres' as const };
  });
}

/** Frees a call's slot. Idempotent: releasing twice, or a call that never held one, is harmless. */
export async function releaseSlot(callId: string): Promise<void> {
  const redis = redisOrNull();
  if (!redis) return; // Postgres counting frees the slot when the call's status leaves the active set.
  const lease = await redis.get(`dialer:lease:${callId}`);
  if (!lease) return;
  for (const key of JSON.parse(lease) as string[]) await redis.zrem(key, callId);
  await redis.del(`dialer:lease:${callId}`);
}

export interface CapacitySnapshot {
  backend: 'redis' | 'postgres';
  plan_cap: number | null;
  active: number;
  by_campaign: { campaign_id: string; active: number; cap: number }[];
}

/** What a tenant is using right now, for the capacity view. */
export async function capacitySnapshot(tenantId: string): Promise<CapacitySnapshot> {
  const plan_cap = await planCapResolver(tenantId);
  const redis = redisOrNull();
  const campaigns = await dataService.rows<{ campaign_id: string; max_concurrency: number }>(
    `SELECT campaign_id, max_concurrency FROM dialer.campaign WHERE tenant_id = $1 AND status IN ('running','paused')`,
    [tenantId],
  );
  if (redis) {
    const now = Date.now();
    const count = async (key: string): Promise<number> => {
      await redis.zremrangebyscore(key, '-inf', now);
      return redis.zcard(key);
    };
    return {
      backend: 'redis',
      plan_cap,
      active: await count(`dialer:active:tenant:${tenantId}`),
      by_campaign: await Promise.all(campaigns.map(async (c) => ({
        campaign_id: c.campaign_id, cap: c.max_concurrency, active: await count(`dialer:active:campaign:${c.campaign_id}`),
      }))),
    };
  }
  const rows = await dataService.rows<{ campaign_id: string | null; n: number }>(
    `SELECT q.campaign_id, count(*)::int AS n
       FROM voice_agent.call c LEFT JOIN dialer.dispatch_queue q ON q.call_id = c.call_id
      WHERE c.tenant_id = $1 AND c.status = ANY($2::text[])
      GROUP BY q.campaign_id`,
    [tenantId, ACTIVE_STATUSES],
  );
  return {
    backend: 'postgres',
    plan_cap,
    active: rows.reduce((a, r) => a + r.n, 0),
    by_campaign: campaigns.map((c) => ({ campaign_id: c.campaign_id, cap: c.max_concurrency, active: rows.find((r) => r.campaign_id === c.campaign_id)?.n ?? 0 })),
  };
}
