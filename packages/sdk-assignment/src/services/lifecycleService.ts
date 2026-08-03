import { dataService } from '@projexlight/db-runtime';

/**
 * Assignment ownership over time (P16 · EP-379 · PCF-06-2).
 *
 * offer -> accept | decline -> backup -> reassign -> complete, with one invariant
 * running through all of it: THE SOURCE TIMESTAMP NEVER MOVES. It is when the world
 * produced the subject — the moment somebody actually asked — and every SLA in the
 * platform is measured from it. A transfer moves ownership, not the clock. Left
 * mutable, each bounce silently resets it, so a subject that has been waiting six
 * hours reads as fresh and the breach report says everything is fine. The database
 * refuses the change too; this file simply never attempts it.
 *
 * A DECLINE REQUIRES A REASON and goes straight to the backup. Both halves matter:
 * "it bounced three times" tells an operator nothing, while "wrong specialty, wrong
 * specialty, out of area" tells them the routing rules are wrong — and a decline that
 * waited for the next sweep would spend the acceptance window twice.
 *
 * SLA clocks are started through a registered hook rather than an import: sdk-sla owns
 * timing, this package owns ownership, and coupling them makes both harder to reuse.
 */

export type AssignmentState =
  | 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'REASSIGNED' | 'FELL_BACK' | 'COMPLETED' | 'CANCELLED';

export interface AssignmentRecord {
  record_id: string;
  tenant_id: string;
  subject_ref: string;
  source_timestamp: string;
  original_persona_id: string;
  primary_persona_id: string;
  backup_persona_id: string | null;
  manager_persona_id: string | null;
  state: AssignmentState;
  offered_at: string;
  accepted_at: string | null;
  closed_at: string | null;
  acceptance_window_minutes: number;
  acceptance_clock_ref: string | null;
  response_clock_ref: string | null;
}

export interface HistoryEntry {
  seq: number;
  from_persona_id: string | null;
  to_persona_id: string | null;
  transition: AssignmentState;
  reason: string | null;
  actor: string | null;
  occurred_at: string;
}

const COLS = `record_id, tenant_id, subject_ref, source_timestamp, original_persona_id,
       primary_persona_id, backup_persona_id, manager_persona_id, state, offered_at,
       accepted_at, closed_at, acceptance_window_minutes, acceptance_clock_ref,
       response_clock_ref`;

export class AssignmentNotFound extends Error {
  readonly code = 'ASSIGNMENT_NOT_FOUND';
  constructor(record_id: string) {
    super(`no assignment ${record_id}`);
    this.name = 'AssignmentNotFound';
  }
}

export class ReasonRequired extends Error {
  readonly code = 'REASON_REQUIRED';
  constructor(action: string) {
    super(`a ${action} must carry a reason`);
    this.name = 'ReasonRequired';
  }
}

export class InvalidTransition extends Error {
  readonly code = 'INVALID_ASSIGNMENT_TRANSITION';
  constructor(from: AssignmentState, action: string) {
    super(`cannot ${action} an assignment that is ${from}`);
    this.name = 'InvalidTransition';
  }
}

export class NoBackupDesignated extends Error {
  readonly code = 'NO_BACKUP_DESIGNATED';
  constructor(record_id: string) {
    super(`assignment ${record_id} has no backup to fall to`);
    this.name = 'NoBackupDesignated';
  }
}

/* ------------------------------------------------------------ the hooks */

export interface ClockRequest {
  tenant_id: string;
  subject_ref: string;
  kind: 'acceptance' | 'response';
  /** The instant the clock is measured FROM — always the source timestamp. */
  source_timestamp: string;
  persona_id: string;
}

/**
 * Start an SLA clock through sdk-sla. No default: a no-op would make every assignment
 * report that its clocks were running when nothing was timing anything, and the first
 * sign would be a breach that never fired.
 */
export type ClockStarter = (req: ClockRequest) => Promise<{ clock_ref: string }>;

let clockStarter: ClockStarter | null = null;

export function setClockStarter(fn: ClockStarter | null): void {
  clockStarter = fn;
}

export function hasClockStarter(): boolean {
  return clockStarter !== null;
}

/* --------------------------------------------------------------- offer */

export interface OfferInput {
  tenant_id: string;
  subject_ref: string;
  /** When the WORLD produced the subject. Defaults to now only for a subject born now. */
  source_timestamp: Date;
  primary_persona_id: string;
  backup_persona_id?: string;
  manager_persona_id?: string;
  acceptance_window_minutes?: number;
  routing_decision_id?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export async function offer(input: OfferInput): Promise<AssignmentRecord> {
  const record = await dataService.tx(async (q) => {
    const row = await q<AssignmentRecord>(
      `INSERT INTO assignment.assignment_record
          (tenant_id, subject_ref, source_timestamp, original_persona_id, primary_persona_id,
           backup_persona_id, manager_persona_id, acceptance_window_minutes,
           routing_decision_id, metadata)
       VALUES ($1, $2, $3, $4, $4, $5, $6, COALESCE($7, 5), $8, $9::jsonb)
       RETURNING ${COLS}`,
      [
        input.tenant_id, input.subject_ref, input.source_timestamp,
        input.primary_persona_id, input.backup_persona_id ?? null,
        input.manager_persona_id ?? null, input.acceptance_window_minutes ?? null,
        input.routing_decision_id ?? null, JSON.stringify(input.metadata ?? {}),
      ],
    );
    await appendHistory(q, {
      record_id: row.rows[0].record_id,
      tenant_id: input.tenant_id,
      from_persona_id: null,
      to_persona_id: input.primary_persona_id,
      transition: 'OFFERED',
      reason: null,
      actor: input.actor ?? null,
    });
    return row.rows[0];
  });

  return startClocks(record, ['acceptance', 'response']);
}

/* -------------------------------------------------------------- accept */

export async function accept(input: {
  tenant_id: string; record_id: string; persona_id?: string; actor?: string;
}): Promise<AssignmentRecord> {
  return dataService.tx(async (q) => {
    const current = await lockRecord(q, input.tenant_id, input.record_id);
    if (current.state === 'ACCEPTED') return current; // idempotent: accepting twice is one acceptance
    if (current.state !== 'OFFERED') throw new InvalidTransition(current.state, 'accept');

    const row = await q<AssignmentRecord>(
      `UPDATE assignment.assignment_record
          SET state = 'ACCEPTED', accepted_at = now()
        WHERE record_id = $1 RETURNING ${COLS}`,
      [input.record_id],
    );
    await appendHistory(q, {
      record_id: input.record_id,
      tenant_id: input.tenant_id,
      from_persona_id: current.primary_persona_id,
      to_persona_id: current.primary_persona_id,
      transition: 'ACCEPTED',
      reason: null,
      actor: input.actor ?? input.persona_id ?? null,
    });
    return row.rows[0];
  });
}

/* ------------------------------------------------------------- decline */

/**
 * Decline, with a reason, straight to the backup.
 *
 * Immediately rather than on the next sweep: a decline that waited would spend the
 * acceptance window twice, once on somebody who has already said no.
 */
export async function decline(input: {
  tenant_id: string; record_id: string; reason: string; actor?: string;
}): Promise<AssignmentRecord> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ReasonRequired('decline');

  const record = await dataService.tx(async (q) => {
    const current = await lockRecord(q, input.tenant_id, input.record_id);
    if (current.state !== 'OFFERED' && current.state !== 'ACCEPTED') {
      throw new InvalidTransition(current.state, 'decline');
    }
    if (!current.backup_persona_id) {
      // Refused rather than left dangling: an assignment nobody owns is invisible.
      throw new NoBackupDesignated(input.record_id);
    }

    const row = await q<AssignmentRecord>(
      `UPDATE assignment.assignment_record
          SET state = 'OFFERED',
              primary_persona_id = backup_persona_id,
              backup_persona_id = NULL,
              accepted_at = NULL,
              offered_at = now()
        WHERE record_id = $1 RETURNING ${COLS}`,
      [input.record_id],
    );
    await appendHistory(q, {
      record_id: input.record_id,
      tenant_id: input.tenant_id,
      from_persona_id: current.primary_persona_id,
      to_persona_id: current.backup_persona_id,
      transition: 'DECLINED',
      reason,
      actor: input.actor ?? null,
    });
    return row.rows[0];
  });

  // A NEW acceptance window for the backup; the response clock keeps running, because
  // the subject has been waiting since source_timestamp either way.
  return startClocks(record, ['acceptance']);
}

/* ------------------------------------------------------------ reassign */

export async function reassign(input: {
  tenant_id: string; record_id: string; to_persona_id: string; reason: string; actor?: string;
}): Promise<AssignmentRecord> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ReasonRequired('reassignment');

  const record = await dataService.tx(async (q) => {
    const current = await lockRecord(q, input.tenant_id, input.record_id);
    if (['COMPLETED', 'CANCELLED'].includes(current.state)) {
      throw new InvalidTransition(current.state, 'reassign');
    }
    const row = await q<AssignmentRecord>(
      `UPDATE assignment.assignment_record
          SET state = 'OFFERED', primary_persona_id = $2, accepted_at = NULL, offered_at = now()
        WHERE record_id = $1 RETURNING ${COLS}`,
      [input.record_id, input.to_persona_id],
    );
    await appendHistory(q, {
      record_id: input.record_id,
      tenant_id: input.tenant_id,
      from_persona_id: current.primary_persona_id,
      to_persona_id: input.to_persona_id,
      transition: 'REASSIGNED',
      reason,
      actor: input.actor ?? null,
    });
    return row.rows[0];
  });
  return startClocks(record, ['acceptance']);
}

/* ------------------------------------------------------------ fallback */

export interface FallbackSweepResult {
  scanned: number;
  fell_back: Array<{ record_id: string; from_persona_id: string; to_persona_id: string }>;
  /** Offers whose window expired with NO backup — they need a human, not silence. */
  stranded: Array<{ record_id: string; primary_persona_id: string }>;
}

/**
 * Hand over every offer whose acceptance window has run out.
 *
 * Stranded offers are REPORTED rather than skipped. An expired window with no backup
 * is the case that most needs somebody's attention, and a sweep that quietly counted
 * it as "nothing to do" is how a subject sits unowned for a day.
 */
export async function sweepExpiredOffers(input: {
  tenant_id: string; now?: Date; limit?: number;
}): Promise<FallbackSweepResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const due = await dataService.rows<AssignmentRecord>(
    `SELECT ${COLS} FROM assignment.assignment_record
      WHERE tenant_id = $1 AND state = 'OFFERED'
        AND offered_at + make_interval(mins => acceptance_window_minutes) <= $2
      ORDER BY offered_at ASC LIMIT ${limit}`,
    [input.tenant_id, now],
  );

  const fell_back: FallbackSweepResult['fell_back'] = [];
  const stranded: FallbackSweepResult['stranded'] = [];

  for (const record of due) {
    if (!record.backup_persona_id) {
      stranded.push({ record_id: record.record_id, primary_persona_id: record.primary_persona_id });
      continue;
    }
    await dataService.tx(async (q) => {
      const current = await lockRecord(q, input.tenant_id, record.record_id);
      if (current.state !== 'OFFERED' || !current.backup_persona_id) return;
      await q(
        `UPDATE assignment.assignment_record
            SET primary_persona_id = backup_persona_id, backup_persona_id = NULL,
                offered_at = now()
          WHERE record_id = $1`,
        [record.record_id],
      );
      await appendHistory(q, {
        record_id: record.record_id,
        tenant_id: input.tenant_id,
        from_persona_id: current.primary_persona_id,
        to_persona_id: current.backup_persona_id,
        transition: 'FELL_BACK',
        // No reason: the system explains itself by being the actor. A REASON is
        // demanded of people, who had a choice.
        reason: null,
        actor: 'system:acceptance-window',
      });
      fell_back.push({
        record_id: record.record_id,
        from_persona_id: current.primary_persona_id,
        to_persona_id: current.backup_persona_id,
      });
    });
  }

  return { scanned: due.length, fell_back, stranded };
}

/* ------------------------------------------------------------- closing */

export async function complete(input: {
  tenant_id: string; record_id: string; actor?: string;
}): Promise<AssignmentRecord> {
  return dataService.tx(async (q) => {
    const current = await lockRecord(q, input.tenant_id, input.record_id);
    if (current.state === 'COMPLETED') return current;
    const row = await q<AssignmentRecord>(
      `UPDATE assignment.assignment_record
          SET state = 'COMPLETED', closed_at = now()
        WHERE record_id = $1 RETURNING ${COLS}`,
      [input.record_id],
    );
    await appendHistory(q, {
      record_id: input.record_id, tenant_id: input.tenant_id,
      from_persona_id: current.primary_persona_id, to_persona_id: current.primary_persona_id,
      transition: 'COMPLETED', reason: null, actor: input.actor ?? null,
    });
    return row.rows[0];
  });
}

/* ---------------------------------------------------------------- reads */

export async function getAssignment(
  tenant_id: string, record_id: string,
): Promise<AssignmentRecord | null> {
  return dataService.one<AssignmentRecord>(
    `SELECT ${COLS} FROM assignment.assignment_record
      WHERE tenant_id = $1 AND record_id = $2`,
    [tenant_id, record_id],
  );
}

/** Every prior owner and why they stopped being one, oldest first. */
export async function getHistory(
  tenant_id: string, record_id: string,
): Promise<HistoryEntry[]> {
  const rows = await dataService.rows<HistoryEntry & { occurred_at: Date }>(
    `SELECT seq, from_persona_id, to_persona_id, transition, reason, actor, occurred_at
       FROM assignment.assignment_history
      WHERE tenant_id = $1 AND record_id = $2 ORDER BY seq ASC`,
    [tenant_id, record_id],
  );
  return rows.map((r) => ({ ...r, occurred_at: new Date(r.occurred_at).toISOString() }));
}

/* -------------------------------------------------------------- helpers */

type Q = <R extends Record<string, unknown>>(
  sql: string, params?: unknown[],
) => Promise<{ rows: R[] }>;

async function lockRecord(q: Q, tenant_id: string, record_id: string): Promise<AssignmentRecord> {
  const res = await q<AssignmentRecord & Record<string, unknown>>(
    `SELECT ${COLS} FROM assignment.assignment_record
      WHERE tenant_id = $1 AND record_id = $2 FOR UPDATE`,
    [tenant_id, record_id],
  );
  if (res.rows.length === 0) throw new AssignmentNotFound(record_id);
  return res.rows[0];
}

async function appendHistory(q: Q, entry: {
  record_id: string; tenant_id: string; from_persona_id: string | null;
  to_persona_id: string | null; transition: AssignmentState; reason: string | null;
  actor: string | null;
}): Promise<void> {
  await q(
    `INSERT INTO assignment.assignment_history
        (record_id, tenant_id, seq, from_persona_id, to_persona_id, transition, reason, actor)
     SELECT $1, $2, COALESCE(max(seq), 0) + 1, $3, $4, $5::assignment.assignment_state, $6, $7
       FROM assignment.assignment_history WHERE record_id = $1`,
    [
      entry.record_id, entry.tenant_id, entry.from_persona_id, entry.to_persona_id,
      entry.transition, entry.reason, entry.actor,
    ],
  );
}

/**
 * Start the requested clocks, always FROM THE SOURCE TIMESTAMP.
 *
 * This is where the invariant would most plausibly be broken: it is tempting to start
 * the response clock at the transfer, which quietly gives every bounce a fresh SLA.
 */
async function startClocks(
  record: AssignmentRecord, kinds: Array<'acceptance' | 'response'>,
): Promise<AssignmentRecord> {
  if (!clockStarter) return record;
  const updates: Record<string, string> = {};
  for (const kind of kinds) {
    try {
      const { clock_ref } = await clockStarter({
        tenant_id: record.tenant_id,
        subject_ref: record.subject_ref,
        kind,
        source_timestamp: record.source_timestamp,
        persona_id: record.primary_persona_id,
      });
      updates[kind === 'acceptance' ? 'acceptance_clock_ref' : 'response_clock_ref'] = clock_ref;
    } catch {
      // A clock we could not start must not lose the assignment: the ref stays null,
      // which is visibly different from a ref that is running.
    }
  }
  if (Object.keys(updates).length === 0) return record;
  const row = await dataService.one<AssignmentRecord>(
    `UPDATE assignment.assignment_record
        SET acceptance_clock_ref = COALESCE($2, acceptance_clock_ref),
            response_clock_ref = COALESCE($3, response_clock_ref)
      WHERE record_id = $1 RETURNING ${COLS}`,
    [record.record_id, updates.acceptance_clock_ref ?? null, updates.response_clock_ref ?? null],
  );
  return row ?? record;
}
