import { dataService } from '@projexlight/db-runtime';
import { getRedis } from '@projexlight/redis-runtime';
import { emitEvent } from '@projexlight/sdk-audit';

/**
 * Plan concurrency alerts (VA·E7 · TK-4504).
 *
 * The plan cap itself is enforced by acquireSlot (the same Redis sorted-set counter the
 * dialer already uses for every dimension). This module adds the early warning: when the
 * tenant's active calls reach the plan's alert threshold — the quota policy's soft cap,
 * 80 % of the plan cap by default — voice.capacity.threshold.v1 is emitted with level
 * 'warning'; when a call is refused because the plan cap is full it is emitted with level
 * 'cap_reached'. Each (tenant, level) alerts once per ALERT_TTL window, deduplicated with a
 * Redis SET NX key (in-process when Redis is down) so a tenant sitting at 80 % is not
 * alerted on every call; the key is cleared when usage falls back below the threshold, so
 * the next crossing alerts again.
 */

export type CapacityAlertLevel = 'warning' | 'cap_reached';

export interface CapacityAlert {
  tenant_id: string;
  level: CapacityAlertLevel;
  active: number;
  plan_cap: number;
  alert_at: number;
  threshold_pct: number;
}

/** Alert threshold for a plan cap: the number of active calls that triggers the warning. */
export type PlanAlertResolver = (tenantId: string, planCap: number) => Promise<number | null>;
export type CapacityAlertListener = (alert: CapacityAlert) => Promise<void> | void;

const DEFAULT_ALERT_PCT = 80;
const ALERT_TTL_S = Number(process.env.DIALER_CAPACITY_ALERT_TTL_S || 900);
const DIALER_AUDIT_POOL = process.env.DIALER_AUDIT_POOL || 'admin-default';
const ACTIVE_STATUSES = ['dialing', 'ringing', 'in_progress'];

/** 80 % of the cap, rounded up, and at least 1. */
export function defaultAlertAt(planCap: number): number {
  return Math.max(1, Math.ceil((planCap * DEFAULT_ALERT_PCT) / 100));
}

let planAlertResolver: PlanAlertResolver = async (_tenantId, planCap) => defaultAlertAt(planCap);
const listeners: CapacityAlertListener[] = [];
const localDedup = new Map<string, number>();

/** Installs the alert-threshold source (the plan quota policy's soft cap). */
export function setPlanAlertResolver(fn: PlanAlertResolver): void {
  planAlertResolver = fn;
}

/** Subscribes to capacity alerts (e.g. to notify tenant admins). */
export function onCapacityAlert(fn: CapacityAlertListener): void {
  listeners.push(fn);
}

/** The alert threshold for a tenant's plan cap, clamped to [1, cap]. */
export async function alertThreshold(tenantId: string, planCap: number): Promise<number> {
  const at = await planAlertResolver(tenantId, planCap);
  const n = at === null || !Number.isFinite(at) ? defaultAlertAt(planCap) : Math.ceil(at);
  return Math.min(planCap, Math.max(1, n));
}

function redisOrNull(): ReturnType<typeof getRedis> | null {
  try {
    return getRedis();
  } catch {
    return null;
  }
}

/** Active calls counted against the plan: the tenant slot set, or the call table without Redis. */
export async function activeCalls(tenantId: string): Promise<number> {
  const redis = redisOrNull();
  if (redis) {
    const key = `dialer:active:tenant:${tenantId}`;
    await redis.zremrangebyscore(key, '-inf', Date.now());
    return redis.zcard(key);
  }
  const row = await dataService.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM voice_agent.call WHERE tenant_id = $1 AND status = ANY($2::text[])`,
    [tenantId, ACTIVE_STATUSES],
  );
  return row?.n ?? 0;
}

const dedupKey = (tenantId: string, level: CapacityAlertLevel) => `dialer:capalert:${level}:${tenantId}`;

async function firstInWindow(tenantId: string, level: CapacityAlertLevel): Promise<boolean> {
  const redis = redisOrNull();
  const key = dedupKey(tenantId, level);
  if (redis) return (await redis.set(key, '1', 'EX', ALERT_TTL_S, 'NX')) === 'OK';
  const until = localDedup.get(key) ?? 0;
  if (until > Date.now()) return false;
  localDedup.set(key, Date.now() + ALERT_TTL_S * 1000);
  return true;
}

async function rearm(tenantId: string): Promise<void> {
  const keys = [dedupKey(tenantId, 'warning'), dedupKey(tenantId, 'cap_reached')];
  const redis = redisOrNull();
  if (redis) await redis.del(...keys);
  for (const k of keys) localDedup.delete(k);
}

async function raise(alert: CapacityAlert): Promise<void> {
  await emitEvent({
    pool_index: DIALER_AUDIT_POOL,
    event_type: 'voice.capacity.threshold.v1',
    actor_kind: 'service',
    actor_id: 'sdk-dialer.capacity',
    tenant_id: alert.tenant_id,
    subject_kind: 'dialer.plan_capacity',
    subject_id: alert.tenant_id,
    payload: { ...alert },
  });
  for (const fn of listeners) {
    try {
      await fn(alert);
    } catch (err) {
      console.error('[sdk-dialer] capacity alert listener failed', (err as Error).message);
    }
  }
}

/**
 * Checks the tenant's usage against its plan after a slot decision. Returns the alert it
 * raised, or null (below threshold, unlimited plan, or already alerted in this window).
 * Never throws: an alert failure must not fail the call it was raised for.
 */
export async function checkPlanThreshold(
  tenantId: string,
  planCap: number | null,
  blockedByPlan: boolean,
): Promise<CapacityAlert | null> {
  if (planCap === null || planCap <= 0) return null;
  try {
    const active = await activeCalls(tenantId);
    const alertAt = await alertThreshold(tenantId, planCap);
    const level: CapacityAlertLevel | null = blockedByPlan ? 'cap_reached' : active >= alertAt ? 'warning' : null;
    if (!level) return null;
    if (!(await firstInWindow(tenantId, level))) return null;
    const alert: CapacityAlert = {
      tenant_id: tenantId,
      level,
      active,
      plan_cap: planCap,
      alert_at: alertAt,
      threshold_pct: Math.round((alertAt / planCap) * 100),
    };
    await raise(alert);
    return alert;
  } catch (err) {
    console.error('[sdk-dialer] capacity threshold check failed', tenantId, (err as Error).message);
    return null;
  }
}

/** After a slot is freed: once usage is back below the threshold, the next crossing alerts again. */
export async function rearmIfBelow(tenantId: string, planCap: number | null): Promise<void> {
  if (planCap === null || planCap <= 0) return;
  try {
    if ((await activeCalls(tenantId)) < (await alertThreshold(tenantId, planCap))) await rearm(tenantId);
  } catch (err) {
    console.error('[sdk-dialer] capacity alert re-arm failed', tenantId, (err as Error).message);
  }
}
