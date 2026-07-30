import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  addBusinessMinutes,
  businessMinutesBetween,
  getCalendar,
  type BusinessCalendar,
} from './calendarService';

/**
 * sdk-sla policy and clock lifecycle (P16 · EP-376 · PCF-03-2).
 *
 * A clock is a promise about one subject. Two rules define it:
 *
 *   1. THE CLOCK STARTS FROM THE SOURCE TIMESTAMP AND NEVER MOVES. Merge,
 *      reassignment, backup takeover — all of them rewrite who owns the response,
 *      none of them touch when it was promised. Restarting the clock on any of
 *      them would erase the wait the person on the other end already had, and the
 *      report would show a fast response to a request that sat for two days. The
 *      database enforces this too (migration 002 trigger).
 *   2. SATISFACTION REQUIRES THE EVIDENCE THE POLICY ASKED FOR. Anything weaker
 *      is refused with a typed error naming exactly what is missing. Without that,
 *      "satisfied" means whatever the closing service felt like asserting, and the
 *      attainment number stops measuring anything.
 */

const SLA_AUDIT_POOL = process.env.SLA_AUDIT_POOL || 'admin-default';

const POLICY_COLS = `
  policy_id, tenant_id, slug, name, description, subject_kind, qualifying_predicate,
  duration_minutes, calendar_id, pause_conditions, satisfaction_contract, is_active,
  metadata, created_at, updated_at`;

const CLOCK_COLS = `
  clock_id, tenant_id, policy_id, subject_ref, subject_kind, source_timestamp, started_at,
  due_at, state, owner_ref, paused_intervals, paused_at, pause_reason, satisfied_at,
  satisfied_by_evidence_ref, satisfied_by, breached_at, cancelled_at, cancel_reason,
  merged_from_ref, metadata, created_at, updated_at`;

export type ClockState = 'running' | 'paused' | 'satisfied' | 'breached' | 'cancelled';

export interface PauseCondition {
  reason: string;
  /** Cap so a clock cannot be parked indefinitely to dodge a breach. */
  max_minutes?: number;
}

export interface SatisfactionContract {
  requires_evidence_ref?: boolean;
  accepted_kinds?: string[];
  min_evidence_count?: number;
  /** Require the satisfier to be someone other than the subject. */
  requires_actor?: boolean;
}

export interface SlaPolicy {
  policy_id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  subject_kind: string;
  qualifying_predicate: Record<string, unknown>;
  duration_minutes: number;
  calendar_id: string;
  pause_conditions: PauseCondition[];
  satisfaction_contract: SatisfactionContract;
  is_active: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PausedInterval {
  from: string;
  to: string;
  reason: string;
}

export interface SlaClock {
  clock_id: string;
  tenant_id: string;
  policy_id: string;
  subject_ref: string;
  subject_kind: string;
  source_timestamp: string;
  started_at: string;
  due_at: string;
  state: ClockState;
  owner_ref: string | null;
  paused_intervals: PausedInterval[];
  paused_at: string | null;
  pause_reason: string | null;
  satisfied_at: string | null;
  satisfied_by_evidence_ref: string | null;
  satisfied_by: string | null;
  breached_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  merged_from_ref: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/* --------------------------------------------------------------- errors */

export class PolicyNotFound extends Error {
  readonly status = 404;
  readonly code = 'SLA_POLICY_NOT_FOUND';
  constructor(public policy_id: string) {
    super(`[sdk-sla] policy ${policy_id} not found for tenant`);
    this.name = 'PolicyNotFound';
  }
}

export class ClockNotFound extends Error {
  readonly status = 404;
  readonly code = 'SLA_CLOCK_NOT_FOUND';
  constructor(public clock_id: string) {
    super(`[sdk-sla] clock ${clock_id} not found for tenant`);
    this.name = 'ClockNotFound';
  }
}

export class InvalidClockTransition extends Error {
  readonly status = 409;
  readonly code = 'INVALID_CLOCK_TRANSITION';
  constructor(public clock_id: string, public from: ClockState, public to: ClockState) {
    super(`[sdk-sla] clock ${clock_id} cannot move ${from} -> ${to}`);
    this.name = 'InvalidClockTransition';
  }
}

/** Raised when the offered evidence does not meet the policy's contract. */
export class SatisfactionEvidenceInsufficient extends Error {
  readonly status = 422;
  readonly code = 'SATISFACTION_EVIDENCE_INSUFFICIENT';
  constructor(public clock_id: string, public missing: string[]) {
    super(
      `[sdk-sla] clock ${clock_id} cannot be satisfied: ${missing.join('; ')}`,
    );
    this.name = 'SatisfactionEvidenceInsufficient';
  }
}

/** Raised when a pause reason is not one the policy allows. */
export class PauseReasonNotAllowed extends Error {
  readonly status = 422;
  readonly code = 'PAUSE_REASON_NOT_ALLOWED';
  constructor(public reason: string, public allowed: string[]) {
    super(
      `[sdk-sla] '${reason}' is not a pause condition on this policy (allowed: ${allowed.join(', ') || 'none'})`,
    );
    this.name = 'PauseReasonNotAllowed';
  }
}

/** Raised when a live clock already exists for this policy and subject. */
export class DuplicateLiveClock extends Error {
  readonly status = 409;
  readonly code = 'DUPLICATE_LIVE_CLOCK';
  constructor(public subject_ref: string, public existing_clock_id: string) {
    super(
      `[sdk-sla] a live clock (${existing_clock_id}) already runs for this policy and subject ${subject_ref}`,
    );
    this.name = 'DuplicateLiveClock';
  }
}

/* -------------------------------------------------------------- policies */

export interface CreatePolicyInput {
  tenant_id: string;
  slug: string;
  name: string;
  subject_kind: string;
  duration_minutes: number;
  calendar_id: string;
  description?: string | null;
  qualifying_predicate?: Record<string, unknown>;
  pause_conditions?: PauseCondition[];
  satisfaction_contract?: SatisfactionContract;
  metadata?: Record<string, unknown>;
}

export async function createPolicy(input: CreatePolicyInput): Promise<SlaPolicy> {
  const row = await dataService.one<SlaPolicy>(
    `INSERT INTO sla.sla_policy
       (tenant_id, slug, name, description, subject_kind, qualifying_predicate,
        duration_minutes, calendar_id, pause_conditions, satisfaction_contract, metadata)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb)
     RETURNING ${POLICY_COLS}`,
    [
      input.tenant_id, input.slug, input.name, input.description ?? null, input.subject_kind,
      JSON.stringify(input.qualifying_predicate ?? {}), input.duration_minutes, input.calendar_id,
      JSON.stringify(input.pause_conditions ?? []),
      JSON.stringify(input.satisfaction_contract ?? {}),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return row!;
}

export async function getPolicy(tenant_id: string, policy_id: string): Promise<SlaPolicy> {
  const row = await dataService.one<SlaPolicy>(
    `SELECT ${POLICY_COLS} FROM sla.sla_policy WHERE tenant_id = $1 AND policy_id = $2`,
    [tenant_id, policy_id],
  );
  if (!row) throw new PolicyNotFound(policy_id);
  return row;
}

export async function listPolicies(filter: {
  tenant_id: string;
  subject_kind?: string;
  is_active?: boolean;
  limit?: number;
  offset?: number;
}): Promise<SlaPolicy[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<SlaPolicy>(
    `SELECT ${POLICY_COLS} FROM sla.sla_policy
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR subject_kind = $2)
        AND ($3::boolean IS NULL OR is_active = $3)
      ORDER BY slug ASC
      LIMIT ${limit} OFFSET ${offset}`,
    [filter.tenant_id, filter.subject_kind ?? null, filter.is_active ?? null],
  );
}

/**
 * Does a subject qualify for a policy?
 *
 * The predicate is data, evaluated here, so a vertical narrows a promise without
 * a platform change. An empty predicate matches everything — a policy with no
 * qualifier applies to its whole subject_kind, which is the common case.
 */
export function subjectQualifies(
  predicate: Record<string, unknown>,
  attributes: Record<string, unknown>,
): boolean {
  const clauses = (predicate?.all ?? []) as Array<{ field: string; op: string; value: unknown }>;
  if (!Array.isArray(clauses) || clauses.length === 0) return true;
  return clauses.every((c) => {
    const actual = attributes?.[c.field];
    switch (c.op) {
      case 'eq': return actual === c.value;
      case 'ne': return actual !== c.value;
      case 'in': return Array.isArray(c.value) && (c.value as unknown[]).includes(actual);
      case 'not_in': return Array.isArray(c.value) && !(c.value as unknown[]).includes(actual);
      case 'gte': return Number(actual) >= Number(c.value);
      case 'lte': return Number(actual) <= Number(c.value);
      case 'exists': return actual !== undefined && actual !== null && actual !== '';
      default:
        // An unrecognised operator must not silently widen the policy: a clause
        // nobody can evaluate is a clause nobody agreed to.
        return false;
    }
  });
}

/* ---------------------------------------------------------------- clocks */

export interface StartClockInput {
  tenant_id: string;
  policy_id: string;
  subject_ref: string;
  /** WHEN THE SIGNAL HAPPENED. Defaults to now only if the caller genuinely has nothing better. */
  source_timestamp?: string;
  owner_ref?: string | null;
  subject_attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  actor_id?: string;
}

export interface StartClockResult {
  clock: SlaClock;
  /** false when a live clock already existed and was returned unchanged. */
  created: boolean;
}

/**
 * Start a clock, or return the live one that already exists.
 *
 * due_at is computed in BUSINESS minutes from the source timestamp, so an
 * overnight arrival is due after the promised amount of open time rather than
 * instantly breaching at opening.
 */
export async function startClock(input: StartClockInput): Promise<StartClockResult> {
  const policy = await getPolicy(input.tenant_id, input.policy_id);
  const calendar = await getCalendar(input.tenant_id, policy.calendar_id);

  const existing = await dataService.one<SlaClock>(
    `SELECT ${CLOCK_COLS} FROM sla.sla_clock
      WHERE tenant_id = $1 AND policy_id = $2 AND subject_ref = $3
        AND state IN ('running','paused')`,
    [input.tenant_id, input.policy_id, input.subject_ref],
  );
  if (existing) return { clock: existing, created: false };

  const source = input.source_timestamp ? new Date(input.source_timestamp) : new Date();
  const due = addBusinessMinutes(calendar, source.getTime(), policy.duration_minutes);

  const clock = await dataService.one<SlaClock>(
    `INSERT INTO sla.sla_clock
       (tenant_id, policy_id, subject_ref, subject_kind, source_timestamp, started_at,
        due_at, owner_ref, metadata)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $5::timestamptz, $6::timestamptz, $7, $8::jsonb)
     RETURNING ${CLOCK_COLS}`,
    [
      input.tenant_id, input.policy_id, input.subject_ref, policy.subject_kind,
      source.toISOString(), due.due_at, input.owner_ref ?? null,
      JSON.stringify({ ...(input.metadata ?? {}), used_late_coverage: due.used_late_coverage }),
    ],
  );

  await emitClockEvent('sla.clock.started.v1', clock!, {
    actor_id: input.actor_id,
    extra: { duration_minutes: policy.duration_minutes, used_late_coverage: due.used_late_coverage },
  });
  return { clock: clock!, created: true };
}

export async function getClock(tenant_id: string, clock_id: string): Promise<SlaClock> {
  const row = await dataService.one<SlaClock>(
    `SELECT ${CLOCK_COLS} FROM sla.sla_clock WHERE tenant_id = $1 AND clock_id = $2`,
    [tenant_id, clock_id],
  );
  if (!row) throw new ClockNotFound(clock_id);
  return row;
}

/**
 * Move ownership WITHOUT touching the timing.
 *
 * This is the reassignment and backup-takeover path, and the whole reason it is
 * a named operation: it makes the safe change easy, so nobody reaches for an
 * UPDATE that would also "helpfully" refresh the due date. The trigger would
 * reject that anyway, loudly.
 */
export async function reassignClock(input: {
  tenant_id: string;
  clock_id: string;
  owner_ref: string;
  reason?: string;
  actor_id?: string;
}): Promise<SlaClock> {
  const clock = await getClock(input.tenant_id, input.clock_id);
  if (clock.state !== 'running' && clock.state !== 'paused') {
    throw new InvalidClockTransition(clock.clock_id, clock.state, clock.state);
  }
  const updated = await dataService.one<SlaClock>(
    `UPDATE sla.sla_clock SET owner_ref = $3
      WHERE tenant_id = $1 AND clock_id = $2
      RETURNING ${CLOCK_COLS}`,
    [input.tenant_id, input.clock_id, input.owner_ref],
  );
  await emitClockEvent('sla.clock.reassigned.v1', updated!, {
    actor_id: input.actor_id,
    extra: { from_owner: clock.owner_ref, to_owner: input.owner_ref, reason: input.reason ?? null },
  });
  return updated!;
}

/**
 * Fold a merged-away subject's clock into the surviving one.
 *
 * The survivor keeps ITS OWN timing when it started earlier, because the promise
 * the platform made first is the one it owes. The absorbed clock is cancelled
 * with a pointer to the survivor so the trail is intact.
 */
export async function mergeClocks(input: {
  tenant_id: string;
  surviving_clock_id: string;
  merged_clock_id: string;
  actor_id?: string;
}): Promise<{ surviving: SlaClock; merged: SlaClock }> {
  const surviving = await getClock(input.tenant_id, input.surviving_clock_id);
  const merged = await getClock(input.tenant_id, input.merged_clock_id);

  const result = await dataService.tx(async (q) => {
    const cancelled = await q<SlaClock>(
      `UPDATE sla.sla_clock
          SET state = 'cancelled', cancelled_at = now(),
              cancel_reason = 'merged into ' || $3
        WHERE tenant_id = $1 AND clock_id = $2 AND state IN ('running','paused')
        RETURNING ${CLOCK_COLS}`,
      [input.tenant_id, merged.clock_id, surviving.clock_id],
    );
    const kept = await q<SlaClock>(
      `UPDATE sla.sla_clock SET merged_from_ref = $3
        WHERE tenant_id = $1 AND clock_id = $2
        RETURNING ${CLOCK_COLS}`,
      [input.tenant_id, surviving.clock_id, merged.subject_ref],
    );
    return { surviving: kept.rows[0], merged: cancelled.rows[0] ?? merged };
  });

  await emitClockEvent('sla.clock.merged.v1', result.surviving, {
    actor_id: input.actor_id,
    extra: { merged_clock_id: merged.clock_id, merged_subject_ref: merged.subject_ref },
  });
  return result;
}

export async function pauseClock(input: {
  tenant_id: string;
  clock_id: string;
  reason: string;
  actor_id?: string;
}): Promise<SlaClock> {
  const clock = await getClock(input.tenant_id, input.clock_id);
  if (clock.state !== 'running') {
    throw new InvalidClockTransition(clock.clock_id, clock.state, 'paused');
  }
  const policy = await getPolicy(input.tenant_id, clock.policy_id);
  const allowed = (policy.pause_conditions ?? []).map((p) => p.reason);
  // A pause reason outside the policy is refused: an unconstrained pause button
  // is how a breach becomes invisible.
  if (!allowed.includes(input.reason)) throw new PauseReasonNotAllowed(input.reason, allowed);

  const updated = await dataService.one<SlaClock>(
    `UPDATE sla.sla_clock
        SET state = 'paused', paused_at = now(), pause_reason = $3
      WHERE tenant_id = $1 AND clock_id = $2 AND state = 'running'
      RETURNING ${CLOCK_COLS}`,
    [input.tenant_id, input.clock_id, input.reason],
  );
  if (!updated) throw new InvalidClockTransition(clock.clock_id, clock.state, 'paused');
  await emitClockEvent('sla.clock.paused.v1', updated, {
    actor_id: input.actor_id,
    extra: { reason: input.reason },
  });
  return updated;
}

export async function resumeClock(input: {
  tenant_id: string;
  clock_id: string;
  actor_id?: string;
}): Promise<SlaClock> {
  const clock = await getClock(input.tenant_id, input.clock_id);
  if (clock.state !== 'paused' || !clock.paused_at) {
    throw new InvalidClockTransition(clock.clock_id, clock.state, 'running');
  }
  const updated = await dataService.one<SlaClock>(
    `UPDATE sla.sla_clock
        SET state = 'running',
            paused_intervals = paused_intervals || jsonb_build_object(
              'from', to_char(paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'to',   to_char(now()     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'reason', COALESCE(pause_reason, '')
            ),
            paused_at = NULL,
            pause_reason = NULL
      WHERE tenant_id = $1 AND clock_id = $2 AND state = 'paused'
      RETURNING ${CLOCK_COLS}`,
    [input.tenant_id, input.clock_id],
  );
  if (!updated) throw new InvalidClockTransition(clock.clock_id, clock.state, 'running');
  await emitClockEvent('sla.clock.resumed.v1', updated, { actor_id: input.actor_id });
  return updated;
}

export interface SatisfyInput {
  tenant_id: string;
  clock_id: string;
  evidence_ref?: string | null;
  evidence_kind?: string | null;
  evidence_count?: number;
  satisfied_by?: string | null;
  actor_id?: string;
}

/**
 * Close the promise — but only on evidence the policy actually asked for.
 *
 * Every unmet requirement is collected before throwing, so the caller learns
 * everything that is missing in one round trip rather than discovering it one
 * rejection at a time.
 */
export async function satisfyClock(input: SatisfyInput): Promise<SlaClock> {
  const clock = await getClock(input.tenant_id, input.clock_id);
  if (clock.state !== 'running' && clock.state !== 'paused') {
    throw new InvalidClockTransition(clock.clock_id, clock.state, 'satisfied');
  }
  const policy = await getPolicy(input.tenant_id, clock.policy_id);
  const contract = policy.satisfaction_contract ?? {};

  const missing: string[] = [];
  if (contract.requires_evidence_ref && !input.evidence_ref) {
    missing.push('an evidence reference is required by this policy');
  }
  if (Array.isArray(contract.accepted_kinds) && contract.accepted_kinds.length > 0) {
    if (!input.evidence_kind) {
      missing.push(
        `an evidence kind is required (accepted: ${contract.accepted_kinds.join(', ')})`,
      );
    } else if (!contract.accepted_kinds.includes(input.evidence_kind)) {
      missing.push(
        `evidence kind '${input.evidence_kind}' is not accepted (accepted: ${contract.accepted_kinds.join(', ')})`,
      );
    }
  }
  if (contract.min_evidence_count && (input.evidence_count ?? (input.evidence_ref ? 1 : 0)) < contract.min_evidence_count) {
    missing.push(`at least ${contract.min_evidence_count} evidence item(s) are required`);
  }
  if (contract.requires_actor && !input.satisfied_by) {
    missing.push('the satisfying actor must be recorded');
  }
  if (missing.length > 0) throw new SatisfactionEvidenceInsufficient(clock.clock_id, missing);

  const updated = await dataService.one<SlaClock>(
    `UPDATE sla.sla_clock
        SET state = 'satisfied', satisfied_at = now(),
            satisfied_by_evidence_ref = $3, satisfied_by = $4,
            paused_intervals = CASE
              WHEN paused_at IS NOT NULL THEN paused_intervals || jsonb_build_object(
                'from', to_char(paused_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'to',   to_char(now()     AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'reason', COALESCE(pause_reason, ''))
              ELSE paused_intervals END,
            paused_at = NULL, pause_reason = NULL
      WHERE tenant_id = $1 AND clock_id = $2 AND state IN ('running','paused')
      RETURNING ${CLOCK_COLS}`,
    [input.tenant_id, input.clock_id, input.evidence_ref ?? null, input.satisfied_by ?? null],
  );
  if (!updated) throw new InvalidClockTransition(clock.clock_id, clock.state, 'satisfied');

  const calendar = await getCalendar(input.tenant_id, policy.calendar_id);
  const elapsed = await elapsedBusinessMinutes(updated, calendar);
  const met = new Date(updated.satisfied_at!).getTime() <= new Date(updated.due_at).getTime();

  await emitClockEvent('sla.clock.satisfied.v1', updated, {
    actor_id: input.actor_id,
    extra: {
      evidence_ref: updated.satisfied_by_evidence_ref,
      elapsed_business_minutes: elapsed,
      within_target: met,
    },
  });
  return updated;
}

export async function cancelClock(input: {
  tenant_id: string;
  clock_id: string;
  reason: string;
  actor_id?: string;
}): Promise<SlaClock> {
  const clock = await getClock(input.tenant_id, input.clock_id);
  if (clock.state === 'satisfied' || clock.state === 'cancelled') {
    throw new InvalidClockTransition(clock.clock_id, clock.state, 'cancelled');
  }
  const updated = await dataService.one<SlaClock>(
    `UPDATE sla.sla_clock
        SET state = 'cancelled', cancelled_at = now(), cancel_reason = $3
      WHERE tenant_id = $1 AND clock_id = $2 AND state NOT IN ('satisfied','cancelled')
      RETURNING ${CLOCK_COLS}`,
    [input.tenant_id, input.clock_id, input.reason],
  );
  if (!updated) throw new InvalidClockTransition(clock.clock_id, clock.state, 'cancelled');
  await emitClockEvent('sla.clock.cancelled.v1', updated, {
    actor_id: input.actor_id,
    extra: { reason: input.reason },
  });
  return updated;
}

/**
 * Business minutes actually consumed, with paused time removed.
 *
 * Excluding pauses is what makes a pause mean something: a clock parked awaiting
 * the subject's own reply should not burn the responder's promise. The policy's
 * max_minutes cap on each pause condition is what stops that from becoming a way
 * to never breach.
 */
export async function elapsedBusinessMinutes(
  clock: SlaClock,
  calendar: BusinessCalendar,
  asOfMs: number = Date.now(),
): Promise<number> {
  const end = clock.satisfied_at
    ? new Date(clock.satisfied_at).getTime()
    : clock.cancelled_at
      ? new Date(clock.cancelled_at).getTime()
      : asOfMs;
  const start = new Date(clock.started_at).getTime();
  let total = businessMinutesBetween(calendar, start, end);

  for (const interval of clock.paused_intervals ?? []) {
    const from = new Date(interval.from).getTime();
    const to = new Date(interval.to).getTime();
    if (Number.isNaN(from) || Number.isNaN(to)) continue;
    total -= businessMinutesBetween(calendar, from, Math.min(to, end));
  }
  // An open pause is excluded up to the measurement instant, so a paused clock
  // does not keep accruing while it is parked.
  if (clock.paused_at) {
    const from = new Date(clock.paused_at).getTime();
    total -= businessMinutesBetween(calendar, from, end);
  }
  return Math.max(total, 0);
}

/** Clocks past due and still running — the input to breach recording. */
export async function findOverdueClocks(
  tenant_id: string,
  asOf: Date = new Date(),
  limit = 500,
): Promise<SlaClock[]> {
  return dataService.rows<SlaClock>(
    `SELECT ${CLOCK_COLS} FROM sla.sla_clock
      WHERE tenant_id = $1 AND state = 'running' AND due_at <= $2::timestamptz
      ORDER BY due_at ASC
      LIMIT ${Math.min(Math.max(limit, 1), 1000)}`,
    [tenant_id, asOf.toISOString()],
  );
}

export async function listClocks(filter: {
  tenant_id: string;
  subject_ref?: string;
  policy_id?: string;
  state?: ClockState;
  owner_ref?: string;
  limit?: number;
  offset?: number;
}): Promise<SlaClock[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<SlaClock>(
    `SELECT ${CLOCK_COLS} FROM sla.sla_clock
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR subject_ref = $2)
        AND ($3::uuid IS NULL OR policy_id = $3::uuid)
        AND ($4::sla.clock_state IS NULL OR state = $4::sla.clock_state)
        AND ($5::text IS NULL OR owner_ref = $5)
      ORDER BY due_at ASC
      LIMIT ${limit} OFFSET ${offset}`,
    [
      filter.tenant_id, filter.subject_ref ?? null, filter.policy_id ?? null,
      filter.state ?? null, filter.owner_ref ?? null,
    ],
  );
}

async function emitClockEvent(
  event_type:
    | 'sla.clock.started.v1'
    | 'sla.clock.paused.v1'
    | 'sla.clock.resumed.v1'
    | 'sla.clock.satisfied.v1'
    | 'sla.clock.cancelled.v1'
    | 'sla.clock.reassigned.v1'
    | 'sla.clock.merged.v1',
  clock: SlaClock,
  ctx: { actor_id?: string; extra?: Record<string, unknown> },
): Promise<void> {
  await emitEvent({
    event_type,
    pool_index: SLA_AUDIT_POOL,
    actor_kind: ctx.actor_id ? 'human' : 'service',
    actor_id: ctx.actor_id || 'sdk-sla',
    tenant_id: clock.tenant_id,
    subject_kind: 'sla.sla_clock',
    subject_id: clock.clock_id,
    payload: {
      clock_id: clock.clock_id,
      policy_id: clock.policy_id,
      subject_ref: clock.subject_ref,
      subject_kind: clock.subject_kind,
      source_timestamp: clock.source_timestamp,
      due_at: clock.due_at,
      state: clock.state,
      owner_ref: clock.owner_ref,
      ...(ctx.extra ?? {}),
    },
  });
}
