import { dataService } from '@projexlight/db-runtime';

/**
 * The overdue queue, and what it costs to move a due date (P16 · EP-380 · PCF-07-2).
 *
 * A due date that moves is normal. A due date that moves five times is a commitment
 * nobody intends to keep, and the two are indistinguishable unless the pattern is
 * carried on the thing a person is looking at when they push it again. So every move
 * is logged with a REQUIRED reason, the count travels with the action, and the date
 * first committed to is frozen — "pushed four times" says nothing about how far the
 * commitment has slipped without it.
 *
 * Escalation offsets are tenant configuration, not constants. "Overdue by a day" means
 * something different for a support ticket and a renewal, and a threshold hard-coded
 * here is a decision made for every tenant by whoever typed it.
 */

export interface EscalationOffset {
  minutes: number;
  level: string;
}

export interface OverduePolicy {
  policy_id: string;
  tenant_id: string;
  subject_kind: string | null;
  offsets: EscalationOffset[];
  push_threshold: number | null;
  is_active: boolean;
}

export class ReasonRequired extends Error {
  readonly code = 'RESCHEDULE_REASON_REQUIRED';
  constructor() {
    super(
      'moving a due date requires a reason — a push with no reason is the whole problem ' +
      'in miniature: the date moves, everyone forgets, and the pattern only surfaces ' +
      'when a quarter closes short',
    );
    this.name = 'ReasonRequired';
  }
}

/**
 * These two used to be reported as RESCHEDULE_REASON_REQUIRED as well, which was simply
 * untrue: a caller that supplied a perfectly good reason was told the reason was missing,
 * and then went looking for a bug in the field they had filled in correctly. An error code
 * is a diagnosis, and three different conditions sharing one code makes every one of them
 * undiagnosable. They are separated here so the message names what actually happened.
 */
export class InvalidDueDate extends Error {
  readonly code = 'RESCHEDULE_INVALID_DUE_DATE';
  constructor(readonly received: unknown) {
    super(
      `new_due_at is not a valid date: ${JSON.stringify(received)} — expected an ISO 8601 ` +
      'timestamp. (An unresolved test placeholder reaches the handler as a literal string ' +
      'and lands here.)',
    );
    this.name = 'InvalidDueDate';
  }
}

export class DueDateUnchanged extends Error {
  readonly code = 'RESCHEDULE_DUE_DATE_UNCHANGED';
  constructor(readonly due_at: string) {
    super(
      `new_due_at (${due_at}) is already this action's due date, so this is not a push. ` +
      'Recording a no-op as a reschedule would inflate the push count and make the ' +
      'date-slippage signal read worse than reality.',
    );
    this.name = 'DueDateUnchanged';
  }
}

export class ManagerReasonRequired extends Error {
  readonly code = 'PUSH_THRESHOLD_REACHED';
  constructor(readonly push_count: number, readonly threshold: number) {
    super(
      `this action has already been pushed ${push_count} time(s), at or past the ` +
      `threshold of ${threshold} — a further push needs a manager's authorisation`,
    );
    this.name = 'ManagerReasonRequired';
  }
}

export class NextActionNotFound extends Error {
  readonly code = 'NEXT_ACTION_NOT_FOUND';
  constructor(id: string) {
    super(`no open next action ${id}`);
    this.name = 'NextActionNotFound';
  }
}

/* -------------------------------------------------------------- policy */

const POLICY_COLS = `policy_id, tenant_id, subject_kind, offsets,
       push_threshold, is_active`;

export async function upsertOverduePolicy(input: {
  tenant_id: string;
  offsets: EscalationOffset[];
  subject_kind?: string | null;
  push_threshold?: number | null;
}): Promise<OverduePolicy> {
  // Sorted ascending here rather than trusted from the caller: an escalation ladder out
  // of order fires 'manager' before 'nudge', which reads as a system nobody configured.
  const offsets = [...(input.offsets ?? [])]
    .filter((o) => Number.isFinite(o.minutes) && o.minutes >= 0 && !!o.level)
    .sort((a, b) => a.minutes - b.minutes);

  const row = await dataService.one<OverduePolicy>(
    `INSERT INTO crm.overdue_policy (tenant_id, subject_kind, offsets, push_threshold)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (tenant_id, COALESCE(subject_kind, ''))
     DO UPDATE SET offsets = EXCLUDED.offsets,
                   push_threshold = EXCLUDED.push_threshold,
                   updated_at = now()
     RETURNING ${POLICY_COLS}`,
    [input.tenant_id, input.subject_kind ?? null, JSON.stringify(offsets),
     input.push_threshold ?? null],
  );
  return row as OverduePolicy;
}

/** The kind-specific policy if there is one, else the tenant-wide one. */
export async function getOverduePolicy(
  tenant_id: string, subject_kind?: string | null,
): Promise<OverduePolicy | null> {
  return dataService.one<OverduePolicy>(
    `SELECT ${POLICY_COLS} FROM crm.overdue_policy
      WHERE tenant_id = $1 AND is_active
        AND (subject_kind = $2 OR subject_kind IS NULL)
      ORDER BY subject_kind NULLS LAST
      LIMIT 1`,
    [tenant_id, subject_kind ?? null],
  );
}

/* --------------------------------------------------------- the queue */

export interface OverdueEntry {
  next_action_id: string;
  subject_ref: string | null;
  subject_kind: string | null;
  owner_persona_id: string | null;
  action_type: string;
  due_at: string;
  original_due_at: string | null;
  minutes_overdue: number;
  push_count: number;
  /** The highest configured level this entry has passed. null = overdue but below the first offset. */
  escalation_level: string | null;
  purpose: string | null;
  intended_outcome: string | null;
}

export interface OverdueQueue {
  entries: OverdueEntry[];
  /** The ladder actually applied, so a caller can render it rather than guess. */
  offsets: EscalationOffset[];
  as_of: string;
}

export async function listOverdue(input: {
  tenant_id: string;
  subject_kind?: string;
  owner_persona_id?: string;
  now?: Date;
  limit?: number;
}): Promise<OverdueQueue> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const policy = await getOverduePolicy(input.tenant_id, input.subject_kind);
  const offsets = policy?.offsets ?? [];

  const rows = await dataService.rows<{
    next_action_id: string; subject_ref: string | null; subject_kind: string | null;
    owner_persona_id: string | null; action_type: string; due_at: Date;
    original_due_at: Date | null; push_count: number; purpose: string | null;
    intended_outcome: string | null; minutes_overdue: string;
  }>(
    `SELECT next_action_id, subject_ref, subject_kind, owner_persona_id, action_type,
            due_at, original_due_at, push_count, purpose, intended_outcome,
            (EXTRACT(EPOCH FROM ($2::timestamptz - due_at)) / 60)::bigint::text AS minutes_overdue
       FROM crm.next_action
      WHERE tenant_id = $1 AND status = 'open' AND due_at < $2
        AND ($3::text IS NULL OR subject_kind = $3)
        AND ($4::uuid IS NULL OR owner_persona_id = $4)
      ORDER BY due_at ASC
      LIMIT ${limit}`,
    [input.tenant_id, now, input.subject_kind ?? null, input.owner_persona_id ?? null],
  );

  return {
    as_of: now.toISOString(),
    offsets,
    entries: rows.map((r) => {
      const minutes_overdue = Number(r.minutes_overdue);
      return {
        next_action_id: r.next_action_id,
        subject_ref: r.subject_ref,
        subject_kind: r.subject_kind,
        owner_persona_id: r.owner_persona_id,
        action_type: r.action_type,
        due_at: new Date(r.due_at).toISOString(),
        original_due_at: r.original_due_at ? new Date(r.original_due_at).toISOString() : null,
        minutes_overdue,
        push_count: r.push_count,
        escalation_level: levelFor(minutes_overdue, offsets),
        purpose: r.purpose,
        intended_outcome: r.intended_outcome,
      };
    }),
  };
}

/**
 * The HIGHEST level whose offset has been passed.
 *
 * Highest rather than first: an action a week overdue is at the manager level, and
 * reporting it as 'nudge' because that offset was passed first would bury it under
 * every action that is an hour late.
 */
export function levelFor(minutes_overdue: number, offsets: EscalationOffset[]): string | null {
  let level: string | null = null;
  for (const offset of [...offsets].sort((a, b) => a.minutes - b.minutes)) {
    if (minutes_overdue >= offset.minutes) level = offset.level;
  }
  return level;
}

/* ---------------------------------------------------------- the push */

export interface PushEntry {
  seq: number;
  from_due_at: string;
  to_due_at: string;
  reason: string;
  approved_by: string | null;
  pushed_by: string | null;
  pushed_at: string;
}

export interface RescheduleResult {
  next_action_id: string;
  subject_ref: string | null;
  due_at: string;
  original_due_at: string | null;
  push_count: number;
  /** Total slip from the FIRST commitment, which is what the count alone cannot say. */
  total_slip_minutes: number | null;
}

export async function reschedule(input: {
  tenant_id: string;
  next_action_id: string;
  new_due_at: Date | string;
  reason: string;
  pushed_by?: string;
  /** A manager's authorisation, required once the push threshold is reached. */
  approved_by?: string;
}): Promise<RescheduleResult> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ReasonRequired();
  const due = input.new_due_at instanceof Date ? input.new_due_at : new Date(input.new_due_at);
  if (Number.isNaN(due.getTime())) {
    throw new InvalidDueDate(input.new_due_at);
  }

  return dataService.tx(async (q) => {
    const current = await q<{
      next_action_id: string; subject_ref: string | null; subject_kind: string | null;
      due_at: Date; original_due_at: Date | null; push_count: number;
    }>(
      `SELECT next_action_id, subject_ref, subject_kind, due_at, original_due_at, push_count
         FROM crm.next_action
        WHERE tenant_id = $1 AND next_action_id = $2 AND status = 'open'
        FOR UPDATE`,
      [input.tenant_id, input.next_action_id],
    );
    if (current.rows.length === 0) throw new NextActionNotFound(input.next_action_id);
    const row = current.rows[0];

    if (new Date(row.due_at).getTime() === due.getTime()) {
      // Not a push; a no-op somebody logged. The constraint refuses it too.
      throw new DueDateUnchanged(String(row.due_at));
    }

    const policy = await q<{ push_threshold: number | null }>(
      `SELECT push_threshold FROM crm.overdue_policy
        WHERE tenant_id = $1 AND is_active AND (subject_kind = $2 OR subject_kind IS NULL)
        ORDER BY subject_kind NULLS LAST LIMIT 1`,
      [input.tenant_id, row.subject_kind],
    );
    const threshold = policy.rows[0]?.push_threshold ?? null;
    if (threshold !== null && row.push_count >= threshold && !(input.approved_by ?? '').trim()) {
      // A ceiling that only warns is not a ceiling. Past it, somebody with authority
      // has to put their name to the slip.
      throw new ManagerReasonRequired(row.push_count, threshold);
    }

    const seq = await q<{ seq: string }>(
      `SELECT COALESCE(max(seq), 0) + 1 AS seq FROM crm.date_push_log
        WHERE next_action_id = $1`,
      [input.next_action_id],
    );
    await q(
      `INSERT INTO crm.date_push_log
          (tenant_id, next_action_id, subject_ref, seq, from_due_at, to_due_at, reason,
           approved_by, pushed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.tenant_id, input.next_action_id, row.subject_ref, Number(seq.rows[0].seq),
        row.due_at, due, reason, input.approved_by ?? null, input.pushed_by ?? null,
      ],
    );

    const updated = await q<{
      due_at: Date; original_due_at: Date | null; push_count: number;
    }>(
      `UPDATE crm.next_action
          SET due_at = $2, push_count = push_count + 1, updated_at = now()
        WHERE next_action_id = $1
        RETURNING due_at, original_due_at, push_count`,
      [input.next_action_id, due],
    );
    const after = updated.rows[0];
    const original = after.original_due_at ? new Date(after.original_due_at) : null;

    return {
      next_action_id: input.next_action_id,
      subject_ref: row.subject_ref,
      due_at: new Date(after.due_at).toISOString(),
      original_due_at: original ? original.toISOString() : null,
      push_count: after.push_count,
      total_slip_minutes: original
        ? Math.round((new Date(after.due_at).getTime() - original.getTime()) / 60_000)
        : null,
    };
  });
}

/* --------------------------------------------------------------- reads */

export async function getPushLog(input: {
  tenant_id: string; next_action_id: string;
}): Promise<PushEntry[]> {
  const rows = await dataService.rows<PushEntry & { from_due_at: Date; to_due_at: Date; pushed_at: Date }>(
    `SELECT seq, from_due_at, to_due_at, reason, approved_by, pushed_by, pushed_at
       FROM crm.date_push_log
      WHERE tenant_id = $1 AND next_action_id = $2 ORDER BY seq ASC`,
    [input.tenant_id, input.next_action_id],
  );
  return rows.map((r) => ({
    ...r,
    from_due_at: new Date(r.from_due_at).toISOString(),
    to_due_at: new Date(r.to_due_at).toISOString(),
    pushed_at: new Date(r.pushed_at).toISOString(),
  }));
}

export interface SubjectPushSummary {
  subject_ref: string;
  push_count: number;
  distinct_actions_pushed: number;
  last_reason: string | null;
  last_pushed_at: string | null;
}

/**
 * How much this subject has slipped, across every action it has had.
 *
 * Per SUBJECT rather than per action on purpose: superseding an action resets its own
 * counter, so a subject could be pushed indefinitely by replacing the action each time
 * and every individual count would read as one.
 */
export async function getSubjectPushSummary(
  tenant_id: string, subject_ref: string,
): Promise<SubjectPushSummary> {
  const row = await dataService.one<{
    push_count: string; distinct_actions_pushed: string;
    last_reason: string | null; last_pushed_at: Date | null;
  }>(
    `SELECT count(*)::text AS push_count,
            count(DISTINCT next_action_id)::text AS distinct_actions_pushed,
            (SELECT reason FROM crm.date_push_log
              WHERE tenant_id = $1 AND subject_ref = $2
              ORDER BY pushed_at DESC LIMIT 1) AS last_reason,
            max(pushed_at) AS last_pushed_at
       FROM crm.date_push_log
      WHERE tenant_id = $1 AND subject_ref = $2`,
    [tenant_id, subject_ref],
  );
  return {
    subject_ref,
    push_count: Number(row?.push_count ?? 0),
    distinct_actions_pushed: Number(row?.distinct_actions_pushed ?? 0),
    last_reason: row?.last_reason ?? null,
    last_pushed_at: row?.last_pushed_at ? new Date(row.last_pushed_at).toISOString() : null,
  };
}
