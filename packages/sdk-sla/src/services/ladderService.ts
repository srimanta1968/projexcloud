import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { addBusinessMinutes, getCalendar, type BusinessCalendar } from './calendarService';
import { getPolicy, type SlaClock, type SlaPolicy } from './clockService';

/**
 * sdk-sla escalation ladder and the idempotent tick evaluator (P16 · EP-376 · PCF-03-3).
 *
 * Two properties carry this file:
 *
 *   1. THE LADDER IS DATA. A rung is a row: when it fires, who hears about it,
 *      how loudly, what action runs and what the recipient should do about it. A
 *      vertical that needs a different ladder inserts different rows; nothing in
 *      this package changes. The action NAME is data too, resolved through a
 *      handler registry the consuming app populates — which is what lets a rung
 *      compose sdk-notification, sdk-assignment, sdk-coverage and sdk-incident
 *      without this package depending on any of them.
 *
 *   2. EACH RUNG FIRES EXACTLY ONCE. The ledger has a UNIQUE (clock_id, rung_id)
 *      and claiming the right to fire IS the insert. Two ticks racing on the same
 *      rung both try; one gets a row, the other gets nothing and moves on. No
 *      lock is held across the action, because an escalation that pages somebody
 *      twice is worse than one that pages them a second late. Retry re-uses the
 *      same ledger row, so a provider outage costs a delay and never a duplicate;
 *      a database trigger refuses to move a row back out of 'fired'.
 *
 * A PAUSED clock does not escalate. Rung times are anchored on the clock's start,
 * the same immutable timeline due_at uses — pausing explains a miss, it does not
 * move the deadline — so the tick simply skips parked clocks and fires anything
 * overdue when they resume, with fire_at and fired_at both recorded so the
 * lateness is visible rather than hidden.
 */

const SLA_AUDIT_POOL = process.env.SLA_AUDIT_POOL || 'admin-default';

/** How long a claimed-but-unconfirmed firing is left alone before another tick may retry it. */
const CLAIM_LEASE_MINUTES = Number(process.env.SLA_RUNG_CLAIM_LEASE_MINUTES || 5);
/** Attempts before a firing stops being retried and stands as a visible failure. */
const MAX_ATTEMPTS = Number(process.env.SLA_RUNG_MAX_ATTEMPTS || 5);

const RUNG_COLS = `
  rung_id, tenant_id, policy_id, rung_index, label, offset_minutes, audience, severity,
  action, action_config, remediation_hint, is_active, metadata, created_at, updated_at`;

const FIRING_COLS = `
  firing_id, tenant_id, clock_id, rung_id, state, attempts, fire_at, claimed_at, fired_at,
  failed_at, next_attempt_at, last_error, audience_snapshot, action_result, created_at, updated_at`;

const CLOCK_COLS_LOCAL = `
  clock_id, tenant_id, policy_id, subject_ref, subject_kind, source_timestamp, started_at,
  due_at, state, owner_ref, paused_intervals, paused_at, pause_reason, satisfied_at,
  satisfied_by_evidence_ref, satisfied_by, breached_at, cancelled_at, cancel_reason,
  merged_from_ref, metadata, created_at, updated_at`;

export type RungSeverity = 'info' | 'warning' | 'urgent' | 'critical';
export type RungFiringState = 'claimed' | 'fired' | 'failed';

export interface RungAudience {
  /** 'owner' | 'refs' | 'on_call' | any kind a custom resolver understands. */
  kind: string;
  refs?: string[];
  rotation_ref?: string;
  [key: string]: unknown;
}

export interface LadderRung {
  rung_id: string;
  tenant_id: string;
  policy_id: string;
  rung_index: number;
  label: string | null;
  /** Business minutes from the clock's start — the same anchor due_at uses. */
  offset_minutes: number;
  audience: RungAudience;
  severity: RungSeverity;
  action: string;
  action_config: Record<string, unknown>;
  remediation_hint: string | null;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RungFiring {
  firing_id: string;
  tenant_id: string;
  clock_id: string;
  rung_id: string;
  state: RungFiringState;
  attempts: number;
  fire_at: string;
  claimed_at: string;
  fired_at: string | null;
  failed_at: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  audience_snapshot: string[];
  action_result: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* --------------------------------------------------------------- errors */

export class LadderRungNotFound extends Error {
  readonly status = 404;
  readonly code = 'SLA_LADDER_RUNG_NOT_FOUND';
  constructor(public rung_id: string) {
    super(`[sdk-sla] ladder rung ${rung_id} not found for tenant`);
    this.name = 'LadderRungNotFound';
  }
}

export class InvalidRungOffset extends Error {
  readonly status = 422;
  readonly code = 'INVALID_RUNG_OFFSET';
  constructor(message: string) {
    super(`[sdk-sla] ${message}`);
    this.name = 'InvalidRungOffset';
  }
}

/** Raised when a rung names an action no handler has been registered for. */
export class RungActionUnhandled extends Error {
  readonly status = 501;
  readonly code = 'RUNG_ACTION_UNHANDLED';
  constructor(public action: string, public registered: string[]) {
    super(
      `[sdk-sla] no handler registered for rung action '${action}' (registered: ${registered.join(', ') || 'none'}) — an escalation that silently does nothing looks identical to one that works`,
    );
    this.name = 'RungActionUnhandled';
  }
}

/** Raised when an audience cannot be resolved to anybody at fire time. */
export class AudienceUnresolvable extends Error {
  readonly status = 422;
  readonly code = 'RUNG_AUDIENCE_UNRESOLVABLE';
  constructor(public kind: string, public detail: string) {
    super(`[sdk-sla] cannot resolve a '${kind}' audience: ${detail}`);
    this.name = 'AudienceUnresolvable';
  }
}

/* ------------------------------------------------- action + audience hooks */

export interface RungActionContext {
  tenant_id: string;
  clock: SlaClock;
  policy: SlaPolicy;
  rung: LadderRung;
  /** Resolved recipients, in the order the resolver returned them. */
  audience: string[];
  /** When the rung became due (as opposed to when it is being executed). */
  fire_at: string;
  /** 1 on the first attempt. */
  attempt: number;
  /** Business minutes elapsed against the promise at fire time, for the message. */
  overdue_minutes: number;
}

export type RungActionHandler = (
  ctx: RungActionContext,
) => Promise<Record<string, unknown> | void>;

const actionHandlers = new Map<string, RungActionHandler>();

/**
 * Register the handler for an action name.
 *
 * The consuming app owns these: 'notify' -> sdk-notification for the audience,
 * 'reassign' -> sdk-assignment, 'open_incident' -> sdk-incident when a breach is
 * systemic. There are deliberately NO defaults. A default no-op would let a
 * production ladder look healthy while escalating to nobody, and that failure is
 * only ever discovered on the day it costs something.
 */
export function registerRungAction(action: string, handler: RungActionHandler): void {
  actionHandlers.set(action, handler);
}

/** Drop a registered handler — mostly useful to keep tests independent. */
export function unregisterRungAction(action: string): void {
  actionHandlers.delete(action);
}

export function registeredRungActions(): string[] {
  return [...actionHandlers.keys()].sort();
}

export type OnCallResolver = (input: {
  tenant_id: string;
  rotation_ref?: string;
  /** Resolve for THIS instant — the person on call now, not when the policy was written. */
  at: string;
  clock: SlaClock;
}) => Promise<string[]>;

let onCallResolver: OnCallResolver | null = null;

/**
 * Wire on-call resolution — sdk-coverage's current on-call roster.
 *
 * No default, on purpose. Firing a 'critical' rung at an empty audience because
 * nobody wired the roster is worse than failing the firing and retrying: the
 * failure is visible in the ledger and recovers itself once the resolver exists.
 */
export function setOnCallResolver(fn: OnCallResolver | null): void {
  onCallResolver = fn;
}

export type AudienceResolver = (input: {
  tenant_id: string;
  audience: RungAudience;
  clock: SlaClock;
  rung: LadderRung;
  at: string;
}) => Promise<string[]>;

let customAudienceResolver: AudienceResolver | null = null;

/** Resolve audience kinds beyond owner / refs / on_call (managers, queues, teams). */
export function setAudienceResolver(fn: AudienceResolver | null): void {
  customAudienceResolver = fn;
}

export async function resolveAudience(
  tenant_id: string,
  rung: LadderRung,
  clock: SlaClock,
  at: string,
): Promise<string[]> {
  const audience = rung.audience ?? { kind: 'owner' };
  switch (audience.kind) {
    case 'owner': {
      if (!clock.owner_ref) {
        throw new AudienceUnresolvable('owner', 'the clock has no current owner');
      }
      return [clock.owner_ref];
    }
    case 'refs': {
      const refs = (audience.refs ?? []).filter((r) => typeof r === 'string' && r.length > 0);
      if (refs.length === 0) throw new AudienceUnresolvable('refs', 'the rung lists no refs');
      return refs;
    }
    case 'on_call': {
      if (!onCallResolver) {
        throw new AudienceUnresolvable(
          'on_call',
          'no on-call resolver is wired (setOnCallResolver) — refusing to escalate to nobody',
        );
      }
      const resolved = await onCallResolver({
        tenant_id, rotation_ref: audience.rotation_ref, at, clock,
      });
      if (!resolved || resolved.length === 0) {
        throw new AudienceUnresolvable('on_call', 'the roster returned nobody for this instant');
      }
      return resolved;
    }
    default: {
      if (!customAudienceResolver) {
        throw new AudienceUnresolvable(
          audience.kind,
          'no custom audience resolver is wired (setAudienceResolver)',
        );
      }
      const resolved = await customAudienceResolver({ tenant_id, audience, clock, rung, at });
      if (!resolved || resolved.length === 0) {
        throw new AudienceUnresolvable(audience.kind, 'the resolver returned nobody');
      }
      return resolved;
    }
  }
}

/* ----------------------------------------------------------------- rungs */

export interface CreateRungInput {
  tenant_id: string;
  policy_id: string;
  rung_index: number;
  action: string;
  /** Business minutes from the clock's start. Give exactly one of the three offsets. */
  offset_minutes?: number;
  /** Convenience: normalised against the policy duration at insert time. */
  minutes_before_due?: number;
  minutes_after_due?: number;
  label?: string | null;
  audience?: RungAudience;
  severity?: RungSeverity;
  action_config?: Record<string, unknown>;
  remediation_hint?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Add a rung.
 *
 * The stored anchor is always business minutes from the clock's start, but a
 * ladder is far easier to reason about as "30 minutes before due, then 15 after".
 * Both spellings are accepted and normalised HERE, once, so the row that fires is
 * the row an operator can read — rather than the two forms drifting apart in
 * evaluation code.
 */
export async function createRung(input: CreateRungInput): Promise<LadderRung> {
  const policy = await getPolicy(input.tenant_id, input.policy_id);
  const given = [input.offset_minutes, input.minutes_before_due, input.minutes_after_due]
    .filter((v) => v !== undefined && v !== null);
  if (given.length !== 1) {
    throw new InvalidRungOffset(
      'give exactly one of offset_minutes, minutes_before_due or minutes_after_due',
    );
  }

  let offset: number;
  if (input.offset_minutes !== undefined && input.offset_minutes !== null) {
    offset = input.offset_minutes;
  } else if (input.minutes_before_due !== undefined && input.minutes_before_due !== null) {
    offset = policy.duration_minutes - input.minutes_before_due;
    if (offset < 0) {
      throw new InvalidRungOffset(
        `minutes_before_due ${input.minutes_before_due} is longer than the policy's ${policy.duration_minutes}-minute promise, which would place the rung before the clock started`,
      );
    }
  } else {
    offset = policy.duration_minutes + (input.minutes_after_due as number);
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new InvalidRungOffset('offset resolves to a negative number of business minutes');
  }

  const row = await dataService.one<LadderRung>(
    `INSERT INTO sla.ladder_rung
       (tenant_id, policy_id, rung_index, label, offset_minutes, audience, severity,
        action, action_config, remediation_hint, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::sla.rung_severity, $8, $9::jsonb, $10, $11::jsonb)
     RETURNING ${RUNG_COLS}`,
    [
      input.tenant_id, input.policy_id, input.rung_index, input.label ?? null, Math.round(offset),
      JSON.stringify(input.audience ?? { kind: 'owner' }), input.severity ?? 'warning',
      input.action, JSON.stringify(input.action_config ?? {}), input.remediation_hint ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function listRungs(filter: {
  tenant_id: string;
  policy_id: string;
  include_inactive?: boolean;
}): Promise<LadderRung[]> {
  return dataService.rows<LadderRung>(
    `SELECT ${RUNG_COLS} FROM sla.ladder_rung
      WHERE tenant_id = $1 AND policy_id = $2
        AND ($3::boolean IS TRUE OR is_active)
      ORDER BY rung_index ASC`,
    [filter.tenant_id, filter.policy_id, filter.include_inactive ?? false],
  );
}

export async function setRungActive(input: {
  tenant_id: string;
  rung_id: string;
  is_active: boolean;
}): Promise<LadderRung> {
  const row = await dataService.one<LadderRung>(
    `UPDATE sla.ladder_rung SET is_active = $3
      WHERE tenant_id = $1 AND rung_id = $2
      RETURNING ${RUNG_COLS}`,
    [input.tenant_id, input.rung_id, input.is_active],
  );
  if (!row) throw new LadderRungNotFound(input.rung_id);
  return row;
}

/**
 * When does this rung become due for this clock?
 *
 * Business minutes on the policy's calendar from the clock's start — the same
 * function and the same anchor that produced due_at, so a rung at
 * offset_minutes === policy.duration_minutes lands exactly on the deadline
 * instead of a minute either side of it.
 */
export function rungFireAt(
  calendar: BusinessCalendar,
  clock: SlaClock,
  rung: LadderRung,
): string {
  const startedMs = new Date(clock.started_at).getTime();
  if (rung.offset_minutes <= 0) return new Date(startedMs).toISOString();
  return addBusinessMinutes(calendar, startedMs, rung.offset_minutes).due_at;
}

export async function listFirings(tenant_id: string, clock_id: string): Promise<RungFiring[]> {
  return dataService.rows<RungFiring>(
    `SELECT ${FIRING_COLS} FROM sla.rung_firing
      WHERE tenant_id = $1 AND clock_id = $2
      ORDER BY fire_at ASC`,
    [tenant_id, clock_id],
  );
}

/* ------------------------------------------------------------------ tick */

export interface TickResult {
  clocks_scanned: number;
  rungs_due: number;
  rungs_fired: number;
  rungs_failed: number;
  /** Claimed by a concurrent tick — the exactly-once guarantee doing its job. */
  rungs_skipped_duplicate: number;
  rungs_retried: number;
  errors: Array<{ clock_id: string; rung_id: string; error: string }>;
}

const emptyResult = (): TickResult => ({
  clocks_scanned: 0, rungs_due: 0, rungs_fired: 0, rungs_failed: 0,
  rungs_skipped_duplicate: 0, rungs_retried: 0, errors: [],
});

/**
 * Evaluate the ladder for every running clock and fire whatever is due.
 *
 * Safe to run concurrently, from as many workers as you like, as often as you
 * like: the ledger decides who fires what. Also safe to run late — a rung that
 * came due an hour ago fires now, and the gap between fire_at and fired_at is
 * recorded so the report shows the ladder ran behind rather than pretending it
 * did not.
 */
export async function runTick(input: {
  tenant_id: string;
  asOf?: Date;
  /** Max clocks examined in one pass. */
  limit?: number;
  actor_id?: string;
}): Promise<TickResult> {
  const asOf = input.asOf ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1000);
  const result = emptyResult();

  // 'breached' is in scope on purpose. The rungs that fire AFTER the deadline are
  // the ones that matter most, and a breach scan marking the clock breached must
  // not quietly end the escalation half way up the ladder. 'paused' stays out: a
  // parked promise does not escalate. Satisfied and cancelled clocks are done.
  const clocks = await dataService.rows<SlaClock>(
    `SELECT ${CLOCK_COLS_LOCAL} FROM sla.sla_clock
      WHERE tenant_id = $1 AND state IN ('running','breached')
      ORDER BY due_at ASC
      LIMIT ${limit}`,
    [input.tenant_id],
  );
  result.clocks_scanned = clocks.length;

  // One read per distinct policy and calendar rather than per clock: a tenant's
  // clocks overwhelmingly share a handful of policies.
  const policies = new Map<string, SlaPolicy>();
  const calendars = new Map<string, BusinessCalendar>();
  const rungs = new Map<string, LadderRung[]>();

  for (const clock of clocks) {
    let policy = policies.get(clock.policy_id);
    if (!policy) {
      policy = await getPolicy(input.tenant_id, clock.policy_id);
      policies.set(clock.policy_id, policy);
    }
    let calendar = calendars.get(policy.calendar_id);
    if (!calendar) {
      calendar = await getCalendar(input.tenant_id, policy.calendar_id);
      calendars.set(policy.calendar_id, calendar);
    }
    let policyRungs = rungs.get(clock.policy_id);
    if (!policyRungs) {
      policyRungs = await listRungs({ tenant_id: input.tenant_id, policy_id: clock.policy_id });
      rungs.set(clock.policy_id, policyRungs);
    }
    if (policyRungs.length === 0) continue;

    for (const rung of policyRungs) {
      const fireAt = rungFireAt(calendar, clock, rung);
      if (new Date(fireAt).getTime() > asOf.getTime()) continue;
      result.rungs_due += 1;

      // THE CLAIM. Inserting the ledger row and winning the right to fire are the
      // same act, so two ticks cannot both proceed.
      const claimed = await dataService.one<RungFiring>(
        `INSERT INTO sla.rung_firing (tenant_id, clock_id, rung_id, fire_at)
         VALUES ($1, $2, $3, $4::timestamptz)
         ON CONFLICT (clock_id, rung_id) DO NOTHING
         RETURNING ${FIRING_COLS}`,
        [input.tenant_id, clock.clock_id, rung.rung_id, fireAt],
      );
      if (!claimed) {
        result.rungs_skipped_duplicate += 1;
        continue;
      }
      await executeFiring({
        firing: claimed, clock, policy, rung, calendar, result, actor_id: input.actor_id,
      });
    }
  }

  await retryFailedFirings({ tenant_id: input.tenant_id, asOf, result, actor_id: input.actor_id });
  return result;
}

/**
 * Retry firings that failed, and firings whose claim went stale because the
 * process holding it died mid-action.
 *
 * Only these two states are eligible — 'fired' is terminal here and at the
 * database, so a retry pass can never turn into a second delivery of a rung that
 * already went out.
 */
async function retryFailedFirings(args: {
  tenant_id: string;
  asOf: Date;
  result: TickResult;
  actor_id?: string;
}): Promise<void> {
  const leaseCutoff = new Date(args.asOf.getTime() - CLAIM_LEASE_MINUTES * 60_000).toISOString();

  const claimed = await dataService.rows<RungFiring>(
    `UPDATE sla.rung_firing
        SET state = 'claimed', attempts = attempts + 1, claimed_at = now(), next_attempt_at = NULL
      WHERE firing_id IN (
        SELECT firing_id FROM sla.rung_firing
         WHERE tenant_id = $1
           AND attempts < $4
           AND (
             (state = 'failed'  AND next_attempt_at IS NOT NULL AND next_attempt_at <= $2::timestamptz)
             OR (state = 'claimed' AND claimed_at <= $3::timestamptz)
           )
         ORDER BY fire_at ASC
         LIMIT 100
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${FIRING_COLS}`,
    [args.tenant_id, args.asOf.toISOString(), leaseCutoff, MAX_ATTEMPTS],
  );

  for (const firing of claimed) {
    const clock = await dataService.one<SlaClock>(
      `SELECT ${CLOCK_COLS_LOCAL} FROM sla.sla_clock WHERE tenant_id = $1 AND clock_id = $2`,
      [args.tenant_id, firing.clock_id],
    );
    const rung = await dataService.one<LadderRung>(
      `SELECT ${RUNG_COLS} FROM sla.ladder_rung WHERE tenant_id = $1 AND rung_id = $2`,
      [args.tenant_id, firing.rung_id],
    );
    if (!clock || !rung) continue;
    // A clock that has since been satisfied or cancelled must not be escalated on
    // a retry — the retry exists to recover a delivery, not to resurrect a
    // situation that has already been resolved. Breached still counts as live:
    // the promise is missed and nobody has answered it yet.
    if (clock.state === 'satisfied' || clock.state === 'cancelled') continue;

    const policy = await getPolicy(args.tenant_id, clock.policy_id);
    const calendar = await getCalendar(args.tenant_id, policy.calendar_id);
    args.result.rungs_retried += 1;
    await executeFiring({
      firing, clock, policy, rung, calendar, result: args.result, actor_id: args.actor_id,
    });
  }
}

/** Resolve the audience, run the action, and record the outcome either way. */
async function executeFiring(args: {
  firing: RungFiring;
  clock: SlaClock;
  policy: SlaPolicy;
  rung: LadderRung;
  calendar: BusinessCalendar;
  result: TickResult;
  actor_id?: string;
}): Promise<void> {
  const { firing, clock, policy, rung, result } = args;
  const handler = actionHandlers.get(rung.action);
  const firedInstant = new Date().toISOString();

  try {
    if (!handler) throw new RungActionUnhandled(rung.action, registeredRungActions());
    const audience = await resolveAudience(firing.tenant_id, rung, clock, firedInstant);
    const overdue = Math.max(
      0,
      Math.round((Date.parse(firedInstant) - Date.parse(clock.due_at)) / 60_000),
    );

    const actionResult = (await handler({
      tenant_id: firing.tenant_id,
      clock, policy, rung, audience,
      fire_at: firing.fire_at,
      attempt: firing.attempts,
      overdue_minutes: overdue,
    })) ?? {};

    const fired = await dataService.one<RungFiring>(
      `UPDATE sla.rung_firing
          SET state = 'fired', fired_at = now(), last_error = NULL, next_attempt_at = NULL,
              audience_snapshot = $2::jsonb, action_result = $3::jsonb
        WHERE firing_id = $1
        RETURNING ${FIRING_COLS}`,
      [firing.firing_id, JSON.stringify(audience), JSON.stringify(actionResult)],
    );
    result.rungs_fired += 1;

    await emitEvent({
      event_type: 'sla.rung.fired.v1',
      pool_index: SLA_AUDIT_POOL,
      actor_kind: args.actor_id ? 'human' : 'service',
      actor_id: args.actor_id || 'sdk-sla',
      tenant_id: firing.tenant_id,
      subject_kind: 'sla.sla_clock',
      subject_id: clock.clock_id,
      payload: {
        clock_id: clock.clock_id,
        policy_id: policy.policy_id,
        subject_ref: clock.subject_ref,
        rung_id: rung.rung_id,
        rung_index: rung.rung_index,
        severity: rung.severity,
        action: rung.action,
        remediation_hint: rung.remediation_hint,
        audience,
        fire_at: firing.fire_at,
        fired_at: fired?.fired_at ?? firedInstant,
        attempt: firing.attempts,
        overdue_minutes: overdue,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // Exponential backoff, capped — and no next attempt once the budget is spent,
    // so an unresolvable rung stands as a visible failure instead of retrying
    // forever and burying the ledger.
    const attempts = firing.attempts;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const backoffMs = Math.min(30_000 * 2 ** (attempts - 1), 3_600_000);
    await dataService.query(
      `UPDATE sla.rung_firing
          SET state = 'failed', failed_at = now(), last_error = $2,
              next_attempt_at = CASE WHEN $3::boolean THEN NULL
                                     ELSE now() + ($4::text || ' milliseconds')::interval END
        WHERE firing_id = $1`,
      [firing.firing_id, message.slice(0, 2000), exhausted, String(backoffMs)],
    );
    result.rungs_failed += 1;
    result.errors.push({ clock_id: clock.clock_id, rung_id: rung.rung_id, error: message });
  }
}

/**
 * Clocks approaching or past their deadline, with ladder progress attached — the
 * read behind an at-risk queue. Ordered by how close the deadline is, because a
 * queue that does not put the next breach first is a list rather than a queue.
 */
export interface AtRiskClock {
  clock: SlaClock;
  minutes_to_due: number;
  is_overdue: boolean;
  rungs_fired: number;
  highest_severity_fired: RungSeverity | null;
  next_rung: { rung_id: string; rung_index: number; severity: RungSeverity; fire_at: string } | null;
}

const SEVERITY_ORDER: RungSeverity[] = ['info', 'warning', 'urgent', 'critical'];

export async function findAtRisk(input: {
  tenant_id: string;
  /** Include clocks due within this many wall-clock minutes (default 60). */
  within_minutes?: number;
  include_overdue?: boolean;
  limit?: number;
  asOf?: Date;
}): Promise<AtRiskClock[]> {
  const asOf = input.asOf ?? new Date();
  const within = Math.max(input.within_minutes ?? 60, 0);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const horizon = new Date(asOf.getTime() + within * 60_000).toISOString();

  const clocks = await dataService.rows<SlaClock>(
    `SELECT ${CLOCK_COLS_LOCAL} FROM sla.sla_clock
      WHERE tenant_id = $1 AND state IN ('running','paused')
        AND due_at <= $2::timestamptz
        AND ($3::boolean OR due_at >= $4::timestamptz)
      ORDER BY due_at ASC
      LIMIT ${limit}`,
    [input.tenant_id, horizon, input.include_overdue ?? true, asOf.toISOString()],
  );
  if (clocks.length === 0) return [];

  const firings = await dataService.rows<RungFiring & { severity: RungSeverity; rung_index: number }>(
    `SELECT f.clock_id, f.rung_id, f.state, f.fire_at, r.severity, r.rung_index
       FROM sla.rung_firing f
       JOIN sla.ladder_rung r ON r.rung_id = f.rung_id
      WHERE f.tenant_id = $1 AND f.clock_id = ANY($2::uuid[])`,
    [input.tenant_id, clocks.map((c) => c.clock_id)],
  );

  const out: AtRiskClock[] = [];
  const calendars = new Map<string, BusinessCalendar>();
  const rungsByPolicy = new Map<string, LadderRung[]>();

  for (const clock of clocks) {
    const policy = await getPolicy(input.tenant_id, clock.policy_id);
    let calendar = calendars.get(policy.calendar_id);
    if (!calendar) {
      calendar = await getCalendar(input.tenant_id, policy.calendar_id);
      calendars.set(policy.calendar_id, calendar);
    }
    let policyRungs = rungsByPolicy.get(clock.policy_id);
    if (!policyRungs) {
      policyRungs = await listRungs({ tenant_id: input.tenant_id, policy_id: clock.policy_id });
      rungsByPolicy.set(clock.policy_id, policyRungs);
    }

    const mine = firings.filter((f) => f.clock_id === clock.clock_id);
    const firedRungIds = new Set(mine.filter((f) => f.state === 'fired').map((f) => f.rung_id));
    const highest = mine
      .filter((f) => f.state === 'fired')
      .reduce<RungSeverity | null>(
        (acc, f) =>
          acc === null || SEVERITY_ORDER.indexOf(f.severity) > SEVERITY_ORDER.indexOf(acc)
            ? f.severity
            : acc,
        null,
      );

    const pending = policyRungs
      .filter((r) => !firedRungIds.has(r.rung_id))
      .map((r) => ({
        rung_id: r.rung_id, rung_index: r.rung_index, severity: r.severity,
        fire_at: rungFireAt(calendar!, clock, r),
      }))
      .sort((a, b) => Date.parse(a.fire_at) - Date.parse(b.fire_at));

    out.push({
      clock,
      minutes_to_due: Math.round((Date.parse(clock.due_at) - asOf.getTime()) / 60_000),
      is_overdue: Date.parse(clock.due_at) <= asOf.getTime(),
      rungs_fired: firedRungIds.size,
      highest_severity_fired: highest,
      next_rung: pending[0] ?? null,
    });
  }
  return out;
}
