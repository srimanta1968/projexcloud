import { dataService } from '@projexlight/db-runtime';

/**
 * The dialer gate chain (VA·E5 · TK-4480).
 *
 * EVERY outbound AI call — a single API request and a campaign contact alike — is run
 * through this one ordered chain before it may take capacity. A gate answers pass, skip
 * (not applicable to this call), defer (not now; try again at next_attempt_at) or refuse
 * (never, for this request). The first defer or refuse stops the chain; every verdict
 * reached is returned so it can be stored on the call.
 *
 * Gates are registered by name with an order. The built-ins here are the ones that need
 * nothing but the dialer's own data; consent / DNC, calling window, recording
 * jurisdiction and concurrency caps register themselves the same way.
 */

export type GateResult = 'pass' | 'skip' | 'defer' | 'refuse';

export interface GateVerdict {
  result: GateResult;
  /** Machine-readable reason for defer / refuse, e.g. campaign_not_running, consent_missing. */
  reason?: string;
  next_attempt_at?: string;
  detail?: Record<string, unknown>;
}

export interface GateContext {
  tenant_id: string;
  call_id: string;
  agent_id: string;
  to_number: string;
  subject_ref: string | null;
  /** sdk-consent person_id of the recipient, when the caller named one. */
  person_id: string | null;
  /** Explicit consent jurisdiction on the call; null = derive from the number. */
  jurisdiction: string | null;
  source: 'api' | 'campaign';
  campaign_id: string | null;
  contact_id: string | null;
  now: Date;
}

export type Gate = (ctx: GateContext) => Promise<GateVerdict>;

export interface ChainOutcome {
  decision: 'allow' | 'defer' | 'refuse';
  reason: string | null;
  next_attempt_at: string | null;
  verdicts: Record<string, GateVerdict & { order: number; evaluated_at: string }>;
}

const gates = new Map<string, { order: number; fn: Gate }>();

/** Adds (or replaces) a gate. Lower order runs first. */
export function registerGate(name: string, order: number, fn: Gate): void {
  gates.set(name, { order, fn });
}

/** The registered gate names in run order. */
export function listGates(): string[] {
  return [...gates.entries()].sort((a, b) => a[1].order - b[1].order).map(([name]) => name);
}

/** Runs the chain. A gate that throws refuses with gate_error — fail closed, never dial blind. */
export async function runGateChain(ctx: GateContext): Promise<ChainOutcome> {
  const verdicts: ChainOutcome['verdicts'] = {};
  for (const [name, { order, fn }] of [...gates.entries()].sort((a, b) => a[1].order - b[1].order)) {
    let v: GateVerdict;
    try {
      v = await fn(ctx);
    } catch (err) {
      v = { result: 'refuse', reason: 'gate_error', detail: { gate: name, message: (err as Error).message } };
    }
    verdicts[name] = { ...v, order, evaluated_at: new Date().toISOString() };
    if (v.result === 'refuse' || v.result === 'defer') {
      return { decision: v.result, reason: v.reason ?? name, next_attempt_at: v.next_attempt_at ?? null, verdicts };
    }
  }
  return { decision: 'allow', reason: null, next_attempt_at: null, verdicts };
}

// ---------------------------------------------------------------------------------------------
// Built-in gates

const ACTIVE_CALL_STATUSES = ['dialing', 'ringing', 'in_progress'];
const IN_FLIGHT_RETRY_MS = 5 * 60 * 1000;

/** A campaign contact is only dialled while its campaign is running. */
registerGate('campaign_active', 10, async (ctx) => {
  if (ctx.source !== 'campaign' || !ctx.campaign_id) return { result: 'skip' };
  const c = await dataService.one<{ status: string }>(
    `SELECT status FROM dialer.campaign WHERE tenant_id = $1 AND campaign_id = $2`,
    [ctx.tenant_id, ctx.campaign_id],
  );
  if (!c) return { result: 'refuse', reason: 'campaign_not_found' };
  if (c.status !== 'running') return { result: 'refuse', reason: 'campaign_not_running', detail: { status: c.status } };
  return { result: 'pass' };
});

/**
 * Never ring a number the tenant is already on the phone with: two agents talking over
 * each other to one person is both a bad experience and a harassment risk. Deferred, not
 * refused — the second call is still wanted, just not now.
 */
registerGate('number_in_flight', 20, async (ctx) => {
  const busy = await dataService.one<{ call_id: string }>(
    `SELECT call_id FROM voice_agent.call
      WHERE tenant_id = $1 AND to_number = $2 AND call_id <> $3 AND direction = 'outbound'
        AND status = ANY($4::text[])
      LIMIT 1`,
    [ctx.tenant_id, ctx.to_number, ctx.call_id, ACTIVE_CALL_STATUSES],
  );
  if (!busy) return { result: 'pass' };
  return {
    result: 'defer',
    reason: 'number_in_flight',
    next_attempt_at: new Date(ctx.now.getTime() + IN_FLIGHT_RETRY_MS).toISOString(),
    detail: { active_call_id: busy.call_id },
  };
});
