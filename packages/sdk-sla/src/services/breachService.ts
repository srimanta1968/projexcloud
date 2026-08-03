import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import { businessMinutesBetween, getCalendar, type BusinessCalendar } from './calendarService';
import {
  elapsedBusinessMinutes,
  getClock,
  getPolicy,
  type SlaClock,
  type SlaPolicy,
} from './clockService';

/**
 * sdk-sla breach recording and attainment reporting (P16 · EP-376 · PCF-03-4).
 *
 * A BREACHED CLOCK AND A BREACH RECORD ARE TWO DIFFERENT THINGS, and keeping them
 * apart is the main design decision in this file:
 *
 *   runBreachScan asserts the arithmetic — the deadline passed. A scanner can do
 *   that knowing nothing about why.
 *
 *   recordBreach is the governed artifact: it demands a reason code, and refuses
 *   without one. If the scanner also had to produce a cause it would have to
 *   invent one, and an invented cause is worse than a missing one because it looks
 *   like an answer. A breached clock with no record therefore appears in
 *   attainment as "cause not recorded" — visible debt somebody can clear.
 *
 * Attainment is computed over BUSINESS minutes, on each policy's own calendar,
 * because a report that measures a business-hours promise in wall-clock time
 * disagrees with the clock that made the promise. Median and P95 come from the
 * same measure, so a percentile and a due date can never tell different stories.
 */

const SLA_AUDIT_POOL = process.env.SLA_AUDIT_POOL || 'admin-default';

/** Ceiling on clocks pulled into one attainment computation. Reported when hit. */
const ATTAINMENT_MAX_CLOCKS = Number(process.env.SLA_ATTAINMENT_MAX_CLOCKS || 5000);

const BREACH_COLS = `
  breach_id, tenant_id, clock_id, policy_id, subject_ref, subject_kind, owner_ref, source_ref,
  due_at, breached_at, elapsed_business_minutes, overdue_business_minutes, reason_code,
  reason_detail, recovery_action, recovered_by, recovered_at, is_systemic, systemic_id,
  recorded_by, metadata, created_at, updated_at`;

const SYSTEMIC_COLS = `
  systemic_id, tenant_id, group_key, incident_ref, incident_error, breach_count,
  first_breach_at, last_breach_at, opened_at, created_at, updated_at`;

const CLOCK_COLS_LOCAL = `
  clock_id, tenant_id, policy_id, subject_ref, subject_kind, source_timestamp, started_at,
  due_at, state, owner_ref, paused_intervals, paused_at, pause_reason, satisfied_at,
  satisfied_by_evidence_ref, satisfied_by, breached_at, cancelled_at, cancel_reason,
  merged_from_ref, metadata, created_at, updated_at`;

export interface BreachReason {
  reason_id: string;
  tenant_id: string;
  code: string;
  label: string | null;
  category: string | null;
  is_auto_registered: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BreachRecord {
  breach_id: string;
  tenant_id: string;
  clock_id: string;
  policy_id: string;
  subject_ref: string;
  subject_kind: string;
  owner_ref: string | null;
  source_ref: string | null;
  due_at: string;
  breached_at: string;
  elapsed_business_minutes: number;
  overdue_business_minutes: number;
  reason_code: string;
  reason_detail: string | null;
  recovery_action: string | null;
  recovered_by: string | null;
  recovered_at: string | null;
  is_systemic: boolean;
  systemic_id: string | null;
  recorded_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SystemicIncident {
  systemic_id: string;
  tenant_id: string;
  group_key: string;
  incident_ref: string | null;
  incident_error: string | null;
  breach_count: number;
  first_breach_at: string;
  last_breach_at: string;
  opened_at: string | null;
  created_at: string;
  updated_at: string;
}

/* --------------------------------------------------------------- errors */

/** Raised when a breach is offered with no cause. */
export class BreachReasonRequired extends Error {
  readonly status = 422;
  readonly code = 'BREACH_REASON_REQUIRED';
  constructor() {
    super(
      '[sdk-sla] a breach cannot be recorded without a reason_code — a miss with no stated cause is a number on a dashboard nobody can act on',
    );
    this.name = 'BreachReasonRequired';
  }
}

export class BreachNotFound extends Error {
  readonly status = 404;
  readonly code = 'SLA_BREACH_NOT_FOUND';
  constructor(public breach_id: string) {
    super(`[sdk-sla] breach record ${breach_id} not found for tenant`);
    this.name = 'BreachNotFound';
  }
}

/** Raised when a clock is offered for breach recording but has not missed anything. */
export class ClockNotBreached extends Error {
  readonly status = 409;
  readonly code = 'CLOCK_NOT_BREACHED';
  constructor(public clock_id: string, public state: string) {
    super(
      `[sdk-sla] clock ${clock_id} is '${state}' and not past due — nothing to record`,
    );
    this.name = 'ClockNotBreached';
  }
}

/* ---------------------------------------------------- incident opener hook */

export type IncidentOpener = (input: {
  tenant_id: string;
  group_key: string;
  reason_code: string;
  policy: SlaPolicy;
  breach_count: number;
  first_breach_at: string;
  summary: string;
}) => Promise<{ incident_ref: string }>;

let incidentOpener: IncidentOpener | null = null;

/**
 * Wire systemic-breach escalation — sdk-incident.
 *
 * No default. If nothing is wired the systemic group is still recorded with a
 * pending incident, so openPendingSystemicIncidents() can open it later; a stub
 * that returned a fake incident id would make an unopened incident look opened,
 * which is the one outcome nobody can recover from.
 */
export function setIncidentOpener(fn: IncidentOpener | null): void {
  incidentOpener = fn;
}

/* ------------------------------------------------------- reason taxonomy */

export async function upsertBreachReason(input: {
  tenant_id: string;
  code: string;
  label?: string | null;
  category?: string | null;
  is_auto_registered?: boolean;
}): Promise<BreachReason> {
  const row = await dataService.one<BreachReason>(
    `INSERT INTO sla.breach_reason (tenant_id, code, label, category, is_auto_registered)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, code) DO UPDATE
       SET label = COALESCE(EXCLUDED.label, sla.breach_reason.label),
           category = COALESCE(EXCLUDED.category, sla.breach_reason.category),
           -- Once a human names a code deliberately it stops being auto-registered.
           is_auto_registered = sla.breach_reason.is_auto_registered AND EXCLUDED.is_auto_registered
     RETURNING reason_id, tenant_id, code, label, category, is_auto_registered, is_active,
               created_at, updated_at`,
    [
      input.tenant_id, input.code.trim(), input.label ?? null, input.category ?? null,
      input.is_auto_registered ?? false,
    ],
  );
  return row!;
}

export async function listBreachReasons(tenant_id: string): Promise<BreachReason[]> {
  return dataService.rows<BreachReason>(
    `SELECT reason_id, tenant_id, code, label, category, is_auto_registered, is_active,
            created_at, updated_at
       FROM sla.breach_reason WHERE tenant_id = $1 ORDER BY code ASC`,
    [tenant_id],
  );
}

/* ------------------------------------------------------------ breach scan */

export interface BreachScanResult {
  clocks_scanned: number;
  clocks_marked: number;
  /** Marked breached but with no cause recorded yet — the queue somebody must clear. */
  awaiting_cause: number;
}

/**
 * Move every past-due running clock to 'breached'.
 *
 * Idempotent: the UPDATE only matches state='running', so a second scan in the
 * same second marks nothing twice and emits nothing twice. It deliberately does
 * NOT invent a reason code.
 */
export async function runBreachScan(input: {
  tenant_id: string;
  asOf?: Date;
  limit?: number;
  actor_id?: string;
}): Promise<BreachScanResult> {
  const asOf = input.asOf ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 2000);

  const marked = await dataService.rows<SlaClock>(
    `UPDATE sla.sla_clock
        SET state = 'breached', breached_at = now()
      WHERE clock_id IN (
        SELECT clock_id FROM sla.sla_clock
         WHERE tenant_id = $1 AND state = 'running' AND due_at <= $2::timestamptz
         ORDER BY due_at ASC
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      )
      RETURNING ${CLOCK_COLS_LOCAL}`,
    [input.tenant_id, asOf.toISOString()],
  );

  for (const clock of marked) {
    const policy = await getPolicy(input.tenant_id, clock.policy_id);
    const calendar = await getCalendar(input.tenant_id, policy.calendar_id);
    await emitEvent({
      event_type: 'sla.clock.breached.v1',
      pool_index: SLA_AUDIT_POOL,
      actor_kind: input.actor_id ? 'human' : 'service',
      actor_id: input.actor_id || 'sdk-sla',
      tenant_id: input.tenant_id,
      subject_kind: 'sla.sla_clock',
      subject_id: clock.clock_id,
      payload: {
        clock_id: clock.clock_id,
        policy_id: clock.policy_id,
        subject_ref: clock.subject_ref,
        owner_ref: clock.owner_ref,
        source_timestamp: clock.source_timestamp,
        due_at: clock.due_at,
        breached_at: clock.breached_at,
        overdue_business_minutes: businessMinutesBetween(
          calendar,
          Date.parse(clock.due_at as unknown as string),
          Date.parse((clock.breached_at ?? asOf.toISOString()) as unknown as string),
        ),
        // Said plainly in the event: the cause is not known yet, and somebody owes one.
        cause_recorded: false,
      },
    });
  }

  const pending = await dataService.one<{ n: string }>(
    `SELECT count(*)::text AS n FROM sla.sla_clock c
      WHERE c.tenant_id = $1 AND c.state = 'breached'
        AND NOT EXISTS (SELECT 1 FROM sla.breach_record b WHERE b.clock_id = c.clock_id)`,
    [input.tenant_id],
  );

  return {
    clocks_scanned: marked.length,
    clocks_marked: marked.length,
    awaiting_cause: Number(pending?.n ?? 0),
  };
}

/* --------------------------------------------------------- breach records */

export interface RecordBreachInput {
  tenant_id: string;
  clock_id: string;
  /** MANDATORY. Free-form per tenant; auto-registered in the taxonomy on first use. */
  reason_code: string;
  reason_detail?: string | null;
  source_ref?: string | null;
  is_systemic?: boolean;
  /** Overrides the derived "same problem" key. */
  systemic_group_key?: string;
  recovery_action?: string | null;
  recovered_by?: string | null;
  recorded_by?: string | null;
  metadata?: Record<string, unknown>;
  actor_id?: string;
}

export interface RecordBreachResult {
  breach: BreachRecord;
  /** false when a record already existed for this clock and was returned unchanged. */
  created: boolean;
  systemic: SystemicIncident | null;
  /** True only when THIS call opened the incident for the group. */
  incident_opened: boolean;
}

/**
 * Record a missed promise, with its cause.
 *
 * Idempotent on the clock: one clock misses its deadline once, and a retried call
 * returns the record that already exists rather than a second one that would
 * double-count in every report. A systemic breach joins a GROUP, and only the
 * call that creates the group opens an incident — so a ladder that fired four
 * rungs, or twenty clocks failing for one reason, still produce exactly one.
 */
export async function recordBreach(input: RecordBreachInput): Promise<RecordBreachResult> {
  const reason = (input.reason_code ?? '').trim();
  if (!reason) throw new BreachReasonRequired();

  const clock = await getClock(input.tenant_id, input.clock_id);
  const existing = await dataService.one<BreachRecord>(
    `SELECT ${BREACH_COLS} FROM sla.breach_record WHERE tenant_id = $1 AND clock_id = $2`,
    [input.tenant_id, input.clock_id],
  );
  if (existing) {
    const group = existing.systemic_id
      ? await dataService.one<SystemicIncident>(
        `SELECT ${SYSTEMIC_COLS} FROM sla.systemic_incident WHERE systemic_id = $1`,
        [existing.systemic_id],
      )
      : null;
    return { breach: existing, created: false, systemic: group, incident_opened: false };
  }

  const policy = await getPolicy(input.tenant_id, clock.policy_id);
  const calendar = await getCalendar(input.tenant_id, policy.calendar_id);
  const dueMs = Date.parse(clock.due_at as unknown as string);
  const breachedMs = clock.breached_at
    ? Date.parse(clock.breached_at as unknown as string)
    : Date.now();
  if (clock.state !== 'breached' && breachedMs <= dueMs) {
    throw new ClockNotBreached(clock.clock_id, clock.state);
  }

  const elapsed = await elapsedBusinessMinutes(clock, calendar, breachedMs);
  const overdue = businessMinutesBetween(calendar, dueMs, breachedMs);

  await upsertBreachReason({
    tenant_id: input.tenant_id, code: reason, is_auto_registered: true,
  });

  const isSystemic = input.is_systemic ?? false;
  let systemic: SystemicIncident | null = null;
  let groupCreated = false;

  if (isSystemic) {
    const groupKey = input.systemic_group_key ?? systemicGroupKey(policy.policy_id, reason, breachedMs);
    // The UNIQUE on (tenant_id, group_key) plus `xmax = 0` is what makes "open
    // exactly one incident" true under concurrency: only a genuine insert reports
    // was_inserted, so N racing breaches in one group open one incident.
    const upserted = await dataService.one<SystemicIncident & { was_inserted: boolean }>(
      `INSERT INTO sla.systemic_incident (tenant_id, group_key, first_breach_at, last_breach_at)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz)
       ON CONFLICT (tenant_id, group_key) DO UPDATE
         SET breach_count = sla.systemic_incident.breach_count + 1,
             last_breach_at = GREATEST(sla.systemic_incident.last_breach_at, EXCLUDED.last_breach_at)
       RETURNING ${SYSTEMIC_COLS}, (xmax = 0) AS was_inserted`,
      [input.tenant_id, groupKey, new Date(breachedMs).toISOString()],
    );
    systemic = upserted!;
    groupCreated = Boolean(upserted?.was_inserted);
  }

  const breach = await dataService.one<BreachRecord>(
    `INSERT INTO sla.breach_record
       (tenant_id, clock_id, policy_id, subject_ref, subject_kind, owner_ref, source_ref,
        due_at, breached_at, elapsed_business_minutes, overdue_business_minutes,
        reason_code, reason_detail, recovery_action, recovered_by, recovered_at,
        is_systemic, systemic_id, recorded_by, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10, $11,
             $12, $13, $14, $15,
             CASE WHEN $14::text IS NULL THEN NULL ELSE now() END,
             $16, $17, $18, $19::jsonb)
     RETURNING ${BREACH_COLS}`,
    [
      input.tenant_id, clock.clock_id, policy.policy_id, clock.subject_ref, clock.subject_kind,
      clock.owner_ref, input.source_ref ?? deriveSourceRef(clock),
      new Date(dueMs).toISOString(), new Date(breachedMs).toISOString(),
      Math.round(elapsed), Math.round(overdue),
      reason, input.reason_detail ?? null, input.recovery_action ?? null,
      input.recovered_by ?? null, isSystemic, systemic?.systemic_id ?? null,
      input.recorded_by ?? null, JSON.stringify(input.metadata ?? {}),
    ],
  );

  // Only the call that created the group opens the incident, and the open happens
  // outside the record's insert: an incident provider being down must never cost
  // the breach record itself.
  let incidentOpened = false;
  if (systemic && groupCreated) {
    incidentOpened = await openIncidentForGroup(input.tenant_id, systemic, reason, policy);
  }

  await emitEvent({
    event_type: 'sla.breach.recorded.v1',
    pool_index: SLA_AUDIT_POOL,
    actor_kind: input.actor_id ? 'human' : 'service',
    actor_id: input.actor_id || 'sdk-sla',
    tenant_id: input.tenant_id,
    subject_kind: 'sla.breach_record',
    subject_id: breach!.breach_id,
    payload: {
      breach_id: breach!.breach_id,
      clock_id: clock.clock_id,
      policy_id: policy.policy_id,
      subject_ref: clock.subject_ref,
      owner_ref: clock.owner_ref,
      reason_code: reason,
      elapsed_business_minutes: breach!.elapsed_business_minutes,
      overdue_business_minutes: breach!.overdue_business_minutes,
      is_systemic: isSystemic,
      systemic_group_key: systemic?.group_key ?? null,
      incident_ref: systemic?.incident_ref ?? null,
      recovery_recorded: Boolean(input.recovery_action),
    },
  });

  return {
    breach: breach!,
    created: true,
    systemic: systemic
      ? (await dataService.one<SystemicIncident>(
        `SELECT ${SYSTEMIC_COLS} FROM sla.systemic_incident WHERE systemic_id = $1`,
        [systemic.systemic_id],
      ))!
      : null,
    incident_opened: incidentOpened,
  };
}

/** "The same problem": one policy, one cause, one hour. */
export function systemicGroupKey(policy_id: string, reason_code: string, atMs: number): string {
  const hour = new Date(atMs).toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return `${policy_id}|${reason_code}|${hour}`;
}

async function openIncidentForGroup(
  tenant_id: string,
  systemic: SystemicIncident,
  reason_code: string,
  policy: SlaPolicy,
): Promise<boolean> {
  if (!incidentOpener) {
    await dataService.query(
      `UPDATE sla.systemic_incident
          SET incident_error = 'no incident opener wired (setIncidentOpener)'
        WHERE systemic_id = $1 AND incident_ref IS NULL`,
      [systemic.systemic_id],
    );
    return false;
  }
  try {
    const opened = await incidentOpener({
      tenant_id,
      group_key: systemic.group_key,
      reason_code,
      policy,
      breach_count: systemic.breach_count,
      first_breach_at: systemic.first_breach_at,
      summary: `Systemic SLA breach on policy ${policy.slug}: ${reason_code}`,
    });
    // WHERE incident_ref IS NULL: if a concurrent retry already opened one, keep
    // the first and let this one go, rather than overwriting the reference the
    // rest of the system may already have followed.
    const row = await dataService.one<SystemicIncident>(
      `UPDATE sla.systemic_incident
          SET incident_ref = $2, incident_error = NULL, opened_at = now()
        WHERE systemic_id = $1 AND incident_ref IS NULL
        RETURNING ${SYSTEMIC_COLS}`,
      [systemic.systemic_id, opened.incident_ref],
    );
    return Boolean(row);
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    await dataService.query(
      `UPDATE sla.systemic_incident SET incident_error = $2 WHERE systemic_id = $1`,
      [systemic.systemic_id, message.slice(0, 2000)],
    );
    return false;
  }
}

/**
 * Retry the groups whose incident never opened.
 *
 * The breach was recorded regardless — this only clears the pending escalation, so
 * wiring the opener late (or recovering from a provider outage) costs nothing
 * beyond a delay.
 */
export async function openPendingSystemicIncidents(input: {
  tenant_id: string;
  limit?: number;
}): Promise<{ attempted: number; opened: number }> {
  const pending = await dataService.rows<SystemicIncident>(
    `SELECT ${SYSTEMIC_COLS} FROM sla.systemic_incident
      WHERE tenant_id = $1 AND incident_ref IS NULL
      ORDER BY created_at ASC
      LIMIT ${Math.min(Math.max(input.limit ?? 50, 1), 500)}`,
    [input.tenant_id],
  );
  let opened = 0;
  for (const group of pending) {
    const sample = await dataService.one<BreachRecord>(
      `SELECT ${BREACH_COLS} FROM sla.breach_record
        WHERE tenant_id = $1 AND systemic_id = $2 ORDER BY breached_at ASC LIMIT 1`,
      [input.tenant_id, group.systemic_id],
    );
    if (!sample) continue;
    const policy = await getPolicy(input.tenant_id, sample.policy_id);
    if (await openIncidentForGroup(input.tenant_id, group, sample.reason_code, policy)) opened += 1;
  }
  return { attempted: pending.length, opened };
}

/** Record what was actually done about a miss. The cause stays as recorded. */
export async function recordRecovery(input: {
  tenant_id: string;
  breach_id: string;
  recovery_action: string;
  recovered_by?: string | null;
}): Promise<BreachRecord> {
  const row = await dataService.one<BreachRecord>(
    `UPDATE sla.breach_record
        SET recovery_action = $3, recovered_by = $4, recovered_at = now()
      WHERE tenant_id = $1 AND breach_id = $2
      RETURNING ${BREACH_COLS}`,
    [input.tenant_id, input.breach_id, input.recovery_action, input.recovered_by ?? null],
  );
  if (!row) throw new BreachNotFound(input.breach_id);
  return row;
}

export async function getBreach(tenant_id: string, breach_id: string): Promise<BreachRecord> {
  const row = await dataService.one<BreachRecord>(
    `SELECT ${BREACH_COLS} FROM sla.breach_record WHERE tenant_id = $1 AND breach_id = $2`,
    [tenant_id, breach_id],
  );
  if (!row) throw new BreachNotFound(breach_id);
  return row;
}

export async function listBreaches(filter: {
  tenant_id: string;
  policy_id?: string;
  owner_ref?: string;
  reason_code?: string;
  from?: string;
  to?: string;
  unrecovered_only?: boolean;
  limit?: number;
  offset?: number;
}): Promise<BreachRecord[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  return dataService.rows<BreachRecord>(
    `SELECT ${BREACH_COLS} FROM sla.breach_record
      WHERE tenant_id = $1
        AND ($2::uuid IS NULL OR policy_id = $2::uuid)
        AND ($3::text IS NULL OR owner_ref = $3)
        AND ($4::text IS NULL OR reason_code = $4)
        AND ($5::timestamptz IS NULL OR breached_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR breached_at <= $6::timestamptz)
        AND (NOT $7::boolean OR recovery_action IS NULL)
      ORDER BY breached_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    [
      filter.tenant_id, filter.policy_id ?? null, filter.owner_ref ?? null,
      filter.reason_code ?? null, filter.from ?? null, filter.to ?? null,
      filter.unrecovered_only ?? false,
    ],
  );
}

/* ---------------------------------------------------------- attainment */

export type AttainmentDimension = 'source' | 'owner' | 'day' | 'hour' | 'reason' | 'policy';

export interface AttainmentMiss {
  clock_id: string;
  subject_ref: string;
  owner_ref: string | null;
  source_ref: string | null;
  breached_at: string;
  elapsed_business_minutes: number;
  overdue_business_minutes: number;
  /** null when the clock breached but nobody has recorded a cause yet. */
  reason_code: string | null;
  reason_detail: string | null;
  recovery_action: string | null;
  recovered_by: string | null;
  is_systemic: boolean;
  incident_ref: string | null;
}

export interface AttainmentStats {
  key: string;
  total: number;
  attained: number;
  breached: number;
  attainment_pct: number;
  median_business_minutes: number | null;
  p95_business_minutes: number | null;
  misses: AttainmentMiss[];
}

export interface AttainmentReport {
  from: string;
  to: string;
  total: number;
  attained: number;
  breached: number;
  attainment_pct: number;
  median_business_minutes: number | null;
  p95_business_minutes: number | null;
  /** Breached clocks with no cause recorded — the report says so rather than guessing. */
  misses_without_cause: number;
  breakdowns: Record<AttainmentDimension, AttainmentStats[]>;
  misses: AttainmentMiss[];
  /** True when the clock ceiling was reached; the numbers then describe a sample. */
  truncated: boolean;
  clocks_considered: number;
}

/** Nearest-rank percentile over a sorted ascending array. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function deriveSourceRef(clock: SlaClock): string | null {
  const meta = (clock.metadata ?? {}) as Record<string, unknown>;
  const candidate = meta.source_ref ?? meta.source ?? meta.channel;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Attainment over a window: how often the promise was kept, how long it actually
 * took, and — for every miss — why and what was done.
 *
 * The duration measure is business minutes on each policy's own calendar, so the
 * percentiles and the due dates describe the same clock. Every miss carries its
 * cause and recovery, and a miss whose cause was never recorded is COUNTED AND
 * NAMED rather than dropped: a report that quietly omits the misses nobody
 * explained flatters itself.
 */
export async function getAttainment(input: {
  tenant_id: string;
  from: string;
  to: string;
  policy_id?: string;
  owner_ref?: string;
  subject_kind?: string;
  dimensions?: AttainmentDimension[];
  max_clocks?: number;
}): Promise<AttainmentReport> {
  const cap = Math.min(Math.max(input.max_clocks ?? ATTAINMENT_MAX_CLOCKS, 1), 50_000);
  const dimensions: AttainmentDimension[] =
    input.dimensions ?? ['source', 'owner', 'day', 'hour', 'reason', 'policy'];

  // Closed clocks only: an open clock has no outcome yet, and counting it as
  // either kept or missed would be a guess.
  const clocks = await dataService.rows<SlaClock>(
    `SELECT ${CLOCK_COLS_LOCAL} FROM sla.sla_clock
      WHERE tenant_id = $1
        AND state IN ('satisfied','breached')
        AND COALESCE(satisfied_at, breached_at) >= $2::timestamptz
        AND COALESCE(satisfied_at, breached_at) <= $3::timestamptz
        AND ($4::uuid IS NULL OR policy_id = $4::uuid)
        AND ($5::text IS NULL OR owner_ref = $5)
        AND ($6::text IS NULL OR subject_kind = $6)
      ORDER BY COALESCE(satisfied_at, breached_at) ASC
      LIMIT ${cap + 1}`,
    [
      input.tenant_id, input.from, input.to, input.policy_id ?? null,
      input.owner_ref ?? null, input.subject_kind ?? null,
    ],
  );
  const truncated = clocks.length > cap;
  const considered = truncated ? clocks.slice(0, cap) : clocks;

  const breaches = considered.length
    ? await dataService.rows<BreachRecord & { incident_ref: string | null }>(
      `SELECT b.${BREACH_COLS.trim().split(/,\s*/).join(', b.')}, s.incident_ref
         FROM sla.breach_record b
         LEFT JOIN sla.systemic_incident s ON s.systemic_id = b.systemic_id
        WHERE b.tenant_id = $1 AND b.clock_id = ANY($2::uuid[])`,
      [input.tenant_id, considered.map((c) => c.clock_id)],
    )
    : [];
  const breachByClock = new Map(breaches.map((b) => [b.clock_id, b]));

  const policies = new Map<string, SlaPolicy>();
  const calendars = new Map<string, BusinessCalendar>();

  interface Row {
    clock: SlaClock;
    attained: boolean;
    minutes: number;
    closedAt: number;
    source: string | null;
    miss: AttainmentMiss | null;
  }
  const rows: Row[] = [];

  for (const clock of considered) {
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

    const closedAtRaw = (clock.satisfied_at ?? clock.breached_at)!;
    const closedAt = Date.parse(closedAtRaw as unknown as string);
    const dueMs = Date.parse(clock.due_at as unknown as string);
    const attained = clock.state === 'satisfied' && closedAt <= dueMs;
    const minutes = Math.round(await elapsedBusinessMinutes(clock, calendar, closedAt));
    const record = breachByClock.get(clock.clock_id);

    rows.push({
      clock, attained, minutes, closedAt,
      source: record?.source_ref ?? deriveSourceRef(clock),
      miss: attained
        ? null
        : {
          clock_id: clock.clock_id,
          subject_ref: clock.subject_ref,
          owner_ref: clock.owner_ref,
          source_ref: record?.source_ref ?? deriveSourceRef(clock),
          breached_at: new Date(closedAt).toISOString(),
          elapsed_business_minutes: minutes,
          overdue_business_minutes:
            record?.overdue_business_minutes
            ?? Math.round(businessMinutesBetween(calendar, dueMs, closedAt)),
          reason_code: record?.reason_code ?? null,
          reason_detail: record?.reason_detail ?? null,
          recovery_action: record?.recovery_action ?? null,
          recovered_by: record?.recovered_by ?? null,
          is_systemic: record?.is_systemic ?? false,
          incident_ref: record?.incident_ref ?? null,
        },
    });
  }

  const summarise = (subset: Row[], key: string): AttainmentStats => {
    const sorted = subset.map((r) => r.minutes).sort((a, b) => a - b);
    const attained = subset.filter((r) => r.attained).length;
    return {
      key,
      total: subset.length,
      attained,
      breached: subset.length - attained,
      attainment_pct: subset.length ? round2((attained / subset.length) * 100) : 0,
      median_business_minutes: percentile(sorted, 50),
      p95_business_minutes: percentile(sorted, 95),
      misses: subset.map((r) => r.miss).filter((m): m is AttainmentMiss => m !== null),
    };
  };

  const keyOf = (row: Row, dim: AttainmentDimension): string => {
    switch (dim) {
      case 'source': return row.source ?? 'unknown';
      case 'owner': return row.clock.owner_ref ?? 'unassigned';
      case 'day': return new Date(row.closedAt).toISOString().slice(0, 10);
      case 'hour': return new Date(row.closedAt).toISOString().slice(0, 13);
      case 'reason': return row.miss ? row.miss.reason_code ?? 'cause_not_recorded' : 'attained';
      case 'policy': return row.clock.policy_id;
    }
  };

  const breakdowns = {} as Record<AttainmentDimension, AttainmentStats[]>;
  for (const dim of dimensions) {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = keyOf(row, dim);
      const bucket = groups.get(key);
      if (bucket) bucket.push(row);
      else groups.set(key, [row]);
    }
    breakdowns[dim] = [...groups.entries()]
      .map(([key, subset]) => summarise(subset, key))
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  const overall = summarise(rows, 'all');
  const misses = rows.map((r) => r.miss).filter((m): m is AttainmentMiss => m !== null);

  return {
    from: input.from,
    to: input.to,
    total: overall.total,
    attained: overall.attained,
    breached: overall.breached,
    attainment_pct: overall.attainment_pct,
    median_business_minutes: overall.median_business_minutes,
    p95_business_minutes: overall.p95_business_minutes,
    misses_without_cause: misses.filter((m) => m.reason_code === null).length,
    breakdowns,
    misses,
    truncated,
    clocks_considered: rows.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
