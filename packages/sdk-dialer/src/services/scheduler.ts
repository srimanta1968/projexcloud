import { dataService } from '@projexlight/db-runtime';
import { acquireSlot, type SlotDecision } from './capacityService';
import { dispatchQueued } from './queueDispatcher';
import { conflict, notFound } from '../models/errors';

/**
 * Weighted fair-share dispatch across tenants, with inbound priority (VA·E5 · TK-4485).
 *
 * FAIRNESS. A scheduler tick drains tenants in weighted round-robin (deficit round
 * robin): every tenant with due calls gets `quantum x weight` dispatches per round, in
 * turn, until the tick's budget is spent or nobody can make progress. A tenant with a
 * 50,000-contact campaign therefore takes its share of each round rather than the whole
 * tick, and a tenant with two calls gets them out in the first round. Within a tenant,
 * dispatchQueued still takes the highest priority and oldest first.
 *
 * INBOUND PRIORITY. Inbound calls never wait in the queue — a caller cannot be put on
 * hold while campaigns drain — and they are admitted against the FULL plan/key cap,
 * while outbound dispatch stops short of it by the inbound reserve (capacityService).
 * Outbound can never occupy the headroom an inbound call needs.
 *
 * The loop is opt-in (DIALER_SCHEDULER_ENABLED=true): until a telephony originator is
 * installed, dispatching only marks calls dialing, which must not happen unattended.
 */

/** Relative share of each round a tenant gets (plan tier); default 1. */
export type TenantWeightResolver = (tenantId: string) => Promise<number>;

let weightResolver: TenantWeightResolver = async () => 1;

export function setTenantWeightResolver(fn: TenantWeightResolver): void {
  weightResolver = fn;
}

export interface TickOptions {
  /** Max dispatches this tick across all tenants (default 200). */
  budget?: number;
  /** Dispatches per tenant per round, before weighting (default 5). */
  quantum?: number;
  /** Restrict the tick to these tenants (operator / test use). */
  tenant_ids?: string[];
}

export interface TickResult {
  rounds: number;
  dispatched: number;
  by_tenant: Record<string, number>;
  /** Tenants that stopped on a full cap this tick. */
  capped: string[];
}

/** One scheduling pass. Safe to run concurrently with itself (claims are leased). */
export async function runSchedulerTick(opts: TickOptions = {}): Promise<TickResult> {
  const budget = opts.budget ?? 200;
  const quantum = opts.quantum ?? 5;
  const tenants = await dataService.rows<{ tenant_id: string }>(
    `SELECT tenant_id
       FROM dialer.dispatch_queue
      WHERE not_before <= now()
        AND (state = 'queued' OR (state = 'dispatching' AND lease_until < now()))
        AND ($1::uuid[] IS NULL OR tenant_id = ANY($1::uuid[]))
      GROUP BY tenant_id
      ORDER BY min(enqueued_at)`,
    [opts.tenant_ids && opts.tenant_ids.length > 0 ? opts.tenant_ids : null],
  );
  const weights = new Map<string, number>();
  for (const t of tenants) weights.set(t.tenant_id, Math.max(1, Math.floor(await weightResolver(t.tenant_id))));

  const result: TickResult = { rounds: 0, dispatched: 0, by_tenant: {}, capped: [] };
  const active = new Set(tenants.map((t) => t.tenant_id));
  while (active.size > 0 && result.dispatched < budget) {
    result.rounds += 1;
    let progress = false;
    for (const tenantId of [...active]) {
      const share = Math.min(quantum * (weights.get(tenantId) ?? 1), budget - result.dispatched);
      if (share <= 0) break;
      const s = await dispatchQueued(tenantId, share);
      if (s.dispatched.length > 0) progress = true;
      result.dispatched += s.dispatched.length;
      result.by_tenant[tenantId] = (result.by_tenant[tenantId] ?? 0) + s.dispatched.length;
      const blockedHard = (s.blocked.plan ?? 0) + (s.blocked.key ?? 0) > 0;
      if (blockedHard && !result.capped.includes(tenantId)) result.capped.push(tenantId);
      // A tenant leaves the rotation when it is capped or has nothing more that is due.
      if (blockedHard || s.dispatched.length < share) active.delete(tenantId);
    }
    if (!progress) break;
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

/** Starts the background loop; returns a stop function. Idempotent. */
export function startDispatchScheduler(intervalMs = Number(process.env.DIALER_SCHEDULER_INTERVAL_MS || 2000)): () => void {
  if (!timer) {
    timer = setInterval(() => {
      if (running) return; // never overlap ticks on one instance
      running = true;
      runSchedulerTick()
        .catch((err) => console.error('[sdk-dialer] scheduler tick failed', (err as Error).message))
        .finally(() => { running = false; });
    }, intervalMs);
    timer.unref?.();
  }
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/**
 * Admits an inbound call to capacity right away (no queue), against the full cap. The
 * voice runtime calls this when a routed INVITE arrives; without a slot it must take the
 * number's fallback (voicemail / forward) instead of answering.
 *
 * @throws DialerError 404 unknown call, 409 not an inbound call or already ended.
 */
export async function admitInbound(tenantId: string, callId: string): Promise<SlotDecision> {
  const call = await dataService.one<{ agent_id: string; direction: string; status: string }>(
    `SELECT agent_id, direction, status FROM voice_agent.call WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, callId],
  );
  if (!call) throw notFound('call not found');
  if (call.direction !== 'inbound') throw conflict('only inbound calls are admitted this way');
  if (['completed', 'failed', 'refused'].includes(call.status)) throw conflict(`call already ended as ${call.status}`);
  const decision = await acquireSlot({ tenant_id: tenantId, call_id: callId, campaign_id: null, agent_id: call.agent_id, direction: 'inbound' });
  if (decision.granted) {
    await dataService.query(
      `UPDATE voice_agent.call SET status = 'in_progress', started_at = COALESCE(started_at, now()),
              answered_at = COALESCE(answered_at, now()), updated_at = now()
        WHERE tenant_id = $1 AND call_id = $2`,
      [tenantId, callId],
    );
  }
  return decision;
}
