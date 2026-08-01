import { dataService } from '@projexlight/db-runtime';

/**
 * Why things closed, and how long they sat before they did (P16 · EP-380 · PCF-07-3).
 *
 * THE TAXONOMY IS THE TENANT'S. A hard-coded close-reason list is a claim that every
 * business loses the same way, and it is unfalsifiable: whatever the list says, people
 * pick the closest option and the report reads back the categories that shipped. So the
 * codes are rows, and adding one is an INSERT rather than a release.
 *
 * THE SUBJECT'S OWN WORDING IS KEPT ALONGSIDE THE CODE. The code is for counting; the
 * sentence is for learning. "Price" hides whether it was too expensive, badly
 * structured, or fine but unbudgeted this quarter — three problems with three different
 * fixes, all filed under one bar on a chart.
 *
 * AGING IS COUNTED IN BUSINESS DAYS. A deal that goes quiet on Friday is not two days
 * stale on Sunday, and a queue that says otherwise trains people to ignore it every
 * Monday. Business time comes from sdk-sla's calendars through a registered hook, so
 * this package neither imports the timing kernel nor reimplements a working week.
 */

export interface CloseReasonType {
  close_reason_type_id: string;
  tenant_id: string;
  code: string;
  label: string;
  outcome_class: 'won' | 'lost' | 'disqualified' | 'paused';
  reactivation_allowed: boolean;
  reactivation_after_days: number | null;
  requires_competitor: boolean;
  requires_learning_note: boolean;
  is_active: boolean;
  sort_order: number;
}

const REASON_COLS = `close_reason_type_id, tenant_id, code, label, outcome_class,
       reactivation_allowed, reactivation_after_days, requires_competitor,
       requires_learning_note, is_active, sort_order`;

export class CloseReasonInvalid extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string) { super(message); this.name = 'CloseReasonInvalid'; }
}

export class CloseReasonNotFound extends Error {
  readonly code = 'CLOSE_REASON_NOT_FOUND';
  constructor(code: string) {
    super(`no active close reason '${code}' for this tenant`);
    this.name = 'CloseReasonNotFound';
  }
}

export class CloseDetailsRequired extends Error {
  readonly code = 'CLOSE_DETAILS_REQUIRED';
  constructor(readonly missing: Array<{ field: string; message: string }>) {
    super(missing.map((m) => m.message).join('; '));
    this.name = 'CloseDetailsRequired';
  }
}

export async function upsertCloseReasonType(input: {
  tenant_id: string;
  code: string;
  label: string;
  outcome_class?: CloseReasonType['outcome_class'];
  reactivation_allowed?: boolean;
  reactivation_after_days?: number | null;
  requires_competitor?: boolean;
  requires_learning_note?: boolean;
  sort_order?: number;
}): Promise<CloseReasonType> {
  const code = (input.code ?? '').trim();
  const label = (input.label ?? '').trim();
  if (!code || !label) throw new CloseReasonInvalid('code and label are required');
  if (input.reactivation_allowed === false && input.reactivation_after_days != null) {
    // "Never come back, after 90 days" is two rules that contradict each other, and
    // whichever the caller meant, somebody downstream will read the other one.
    throw new CloseReasonInvalid(
      'reactivation_after_days makes no sense when reactivation is not allowed');
  }
  const row = await dataService.one<CloseReasonType>(
    `INSERT INTO crm.close_reason_type
        (tenant_id, code, label, outcome_class, reactivation_allowed, reactivation_after_days,
         requires_competitor, requires_learning_note, sort_order)
     VALUES ($1, $2, $3, COALESCE($4, 'lost'), COALESCE($5, true), $6,
             COALESCE($7, false), COALESCE($8, false), COALESCE($9, 100))
     ON CONFLICT (tenant_id, code)
     DO UPDATE SET label = EXCLUDED.label,
                   outcome_class = EXCLUDED.outcome_class,
                   reactivation_allowed = EXCLUDED.reactivation_allowed,
                   reactivation_after_days = EXCLUDED.reactivation_after_days,
                   requires_competitor = EXCLUDED.requires_competitor,
                   requires_learning_note = EXCLUDED.requires_learning_note,
                   sort_order = EXCLUDED.sort_order,
                   updated_at = now()
     RETURNING ${REASON_COLS}`,
    [
      input.tenant_id, code, label, input.outcome_class ?? null,
      input.reactivation_allowed ?? null, input.reactivation_after_days ?? null,
      input.requires_competitor ?? null, input.requires_learning_note ?? null,
      input.sort_order ?? null,
    ],
  );
  return row as CloseReasonType;
}

export async function listCloseReasonTypes(
  tenant_id: string, include_inactive = false,
): Promise<CloseReasonType[]> {
  return dataService.rows<CloseReasonType>(
    `SELECT ${REASON_COLS} FROM crm.close_reason_type
      WHERE tenant_id = $1 AND ($2 OR is_active)
      ORDER BY sort_order ASC, code ASC`,
    [tenant_id, include_inactive],
  );
}

/* ---------------------------------------------------------- closing */

export interface SubjectClose {
  close_id: string;
  subject_ref: string;
  code: string;
  outcome_class: string;
  subject_wording: string | null;
  offer_version: string | null;
  contract_version: string | null;
  competitor: string | null;
  learning_note: string | null;
  stage_at_close: string | null;
  closed_at: string;
  reactivate_after: string | null;
  reactivation_allowed: boolean;
}

export async function closeSubject(input: {
  tenant_id: string;
  subject_ref: string;
  code: string;
  subject_kind?: string;
  subject_wording?: string;
  offer_version?: string;
  contract_version?: string;
  competitor?: string;
  learning_note?: string;
  stage_at_close?: string;
  closed_by?: string;
  closed_at?: Date;
}): Promise<SubjectClose> {
  const type = await dataService.one<CloseReasonType>(
    `SELECT ${REASON_COLS} FROM crm.close_reason_type
      WHERE tenant_id = $1 AND code = $2 AND is_active`,
    [input.tenant_id, input.code],
  );
  if (!type) throw new CloseReasonNotFound(input.code);

  // What a reason REQUIRES is part of the taxonomy, not of this code: a tenant that
  // wants a competitor named on every competitive loss says so on the reason.
  const missing: Array<{ field: string; message: string }> = [];
  if (type.requires_competitor && !(input.competitor ?? '').trim()) {
    missing.push({
      field: 'competitor',
      message: `close reason '${type.code}' requires naming the competing option`,
    });
  }
  if (type.requires_learning_note && !(input.learning_note ?? '').trim()) {
    missing.push({
      field: 'learning_note',
      message: `close reason '${type.code}' requires a learning note — the point of recording a loss is to change something`,
    });
  }
  if (missing.length > 0) throw new CloseDetailsRequired(missing);

  const closed_at = input.closed_at ?? new Date();
  const reactivate_after = type.reactivation_allowed && type.reactivation_after_days != null
    ? new Date(closed_at.getTime() + type.reactivation_after_days * 86_400_000)
    : null;

  const row = await dataService.one<{ close_id: string; closed_at: Date; reactivate_after: Date | null }>(
    `INSERT INTO crm.subject_close
        (tenant_id, subject_ref, subject_kind, close_reason_type_id, subject_wording,
         offer_version, contract_version, competitor, learning_note, stage_at_close,
         closed_by, closed_at, reactivate_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING close_id, closed_at, reactivate_after`,
    [
      input.tenant_id, input.subject_ref, input.subject_kind ?? kindOf(input.subject_ref),
      type.close_reason_type_id, input.subject_wording ?? null, input.offer_version ?? null,
      input.contract_version ?? null, input.competitor ?? null, input.learning_note ?? null,
      input.stage_at_close ?? null, input.closed_by ?? null, closed_at, reactivate_after,
    ],
  );

  return {
    close_id: row!.close_id,
    subject_ref: input.subject_ref,
    code: type.code,
    outcome_class: type.outcome_class,
    subject_wording: input.subject_wording ?? null,
    offer_version: input.offer_version ?? null,
    contract_version: input.contract_version ?? null,
    competitor: input.competitor ?? null,
    learning_note: input.learning_note ?? null,
    stage_at_close: input.stage_at_close ?? null,
    closed_at: new Date(row!.closed_at).toISOString(),
    reactivate_after: row!.reactivate_after ? new Date(row!.reactivate_after).toISOString() : null,
    reactivation_allowed: type.reactivation_allowed,
  };
}

export interface ReactivationVerdict {
  subject_ref: string;
  closed: boolean;
  allowed: boolean;
  /** Null when it was never closed, or when it may be approached now. */
  eligible_at: string | null;
  code: string | null;
  reason: string;
}

/**
 * May this subject be approached again?
 *
 * Answered from the taxonomy rather than from a global cooling-off number, because
 * "lost on price this quarter" and "not a real buyer" are both losses and only one of
 * them is worth calling. A single rule for both produces either a do-not-call list that
 * swallows winnable business or a re-approach that annoys people who already said never.
 */
export async function checkReactivation(
  tenant_id: string, subject_ref: string, now = new Date(),
): Promise<ReactivationVerdict> {
  const row = await dataService.one<{
    code: string; reactivation_allowed: boolean; reactivate_after: Date | null;
  }>(
    `SELECT t.code, t.reactivation_allowed, c.reactivate_after
       FROM crm.subject_close c
       JOIN crm.close_reason_type t ON t.close_reason_type_id = c.close_reason_type_id
      WHERE c.tenant_id = $1 AND c.subject_ref = $2
      ORDER BY c.closed_at DESC LIMIT 1`,
    [tenant_id, subject_ref],
  );
  if (!row) {
    return { subject_ref, closed: false, allowed: true, eligible_at: null, code: null,
      reason: 'this subject has not been closed' };
  }
  if (!row.reactivation_allowed) {
    return { subject_ref, closed: true, allowed: false, eligible_at: null, code: row.code,
      reason: `closed as '${row.code}', which does not allow reactivation` };
  }
  if (row.reactivate_after && new Date(row.reactivate_after) > now) {
    return {
      subject_ref, closed: true, allowed: false,
      eligible_at: new Date(row.reactivate_after).toISOString(), code: row.code,
      reason: `closed as '${row.code}'; may be approached again after the cooling-off period`,
    };
  }
  return { subject_ref, closed: true, allowed: true, eligible_at: null, code: row.code,
    reason: `closed as '${row.code}', and the cooling-off period has passed` };
}

/** Closed subjects that have become approachable again, for a re-engagement queue. */
export async function listReactivatable(input: {
  tenant_id: string; now?: Date; limit?: number;
}): Promise<Array<{ subject_ref: string; code: string; closed_at: string; eligible_since: string }>> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 1000);
  const rows = await dataService.rows<{
    subject_ref: string; code: string; closed_at: Date; reactivate_after: Date;
  }>(
    `SELECT c.subject_ref, t.code, c.closed_at, c.reactivate_after
       FROM crm.subject_close c
       JOIN crm.close_reason_type t ON t.close_reason_type_id = c.close_reason_type_id
      WHERE c.tenant_id = $1 AND t.reactivation_allowed
        AND c.reactivate_after IS NOT NULL AND c.reactivate_after <= $2
      ORDER BY c.reactivate_after ASC
      LIMIT ${limit}`,
    [input.tenant_id, now],
  );
  return rows.map((r) => ({
    subject_ref: r.subject_ref,
    code: r.code,
    closed_at: new Date(r.closed_at).toISOString(),
    eligible_since: new Date(r.reactivate_after).toISOString(),
  }));
}

/* ------------------------------------------------------- stage aging */

export interface StageEntryRow {
  stage_entry_id: string;
  subject_ref: string;
  stage: string;
  owner_persona_id: string | null;
  entered_at: string;
  last_activity_at: string | null;
}

/** Move a subject into a stage, closing the previous one. */
export async function enterStage(input: {
  tenant_id: string;
  subject_ref: string;
  stage: string;
  subject_kind?: string;
  owner_persona_id?: string;
  entered_at?: Date;
}): Promise<StageEntryRow> {
  return dataService.tx(async (q) => {
    await q(
      `UPDATE crm.stage_entry SET exited_at = COALESCE($3, now())
        WHERE tenant_id = $1 AND subject_ref = $2 AND exited_at IS NULL`,
      [input.tenant_id, input.subject_ref, input.entered_at ?? null],
    );
    const row = await q<StageEntryRow>(
      `INSERT INTO crm.stage_entry
          (tenant_id, subject_ref, subject_kind, stage, owner_persona_id, entered_at,
           last_activity_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()), COALESCE($6, now()))
       RETURNING stage_entry_id, subject_ref, stage, owner_persona_id, entered_at, last_activity_at`,
      [
        input.tenant_id, input.subject_ref, input.subject_kind ?? kindOf(input.subject_ref),
        input.stage, input.owner_persona_id ?? null, input.entered_at ?? null,
      ],
    );
    return row.rows[0];
  });
}

/**
 * Record that something MEANINGFUL happened.
 *
 * Called explicitly rather than derived from updated_at: aging is about silence, and an
 * edit is not contact. A "days since activity" number that resets when somebody fixes a
 * phone number is worse than none, because it looks maintained.
 */
export async function recordActivity(input: {
  tenant_id: string; subject_ref: string; at?: Date;
}): Promise<void> {
  await dataService.query(
    `UPDATE crm.stage_entry SET last_activity_at = COALESCE($3, now())
      WHERE tenant_id = $1 AND subject_ref = $2 AND exited_at IS NULL`,
    [input.tenant_id, input.subject_ref, input.at ?? null],
  );
}

/**
 * Business-day arithmetic, delegated.
 *
 * NO DEFAULT that falls back to calendar days: a deal that goes quiet on Friday is not
 * two days stale on Sunday, and silently answering in calendar days would make the
 * queue wrong every Monday in a way nobody would notice. Unwired, the aging report says
 * so in its own result.
 */
export type BusinessDaysResolver = (input: {
  tenant_id: string; from: Date; to: Date;
}) => Promise<number>;

let businessDays: BusinessDaysResolver | null = null;

export function setBusinessDaysResolver(fn: BusinessDaysResolver | null): void {
  businessDays = fn;
}

export function hasBusinessDaysResolver(): boolean {
  return businessDays !== null;
}

export interface AgingEntry {
  subject_ref: string;
  stage: string;
  owner_persona_id: string | null;
  entered_at: string;
  last_activity_at: string | null;
  business_days_in_stage: number | null;
  business_days_since_activity: number | null;
  calendar_days_in_stage: number;
}

export interface AgingReport {
  entries: AgingEntry[];
  as_of: string;
  /** False when no business calendar is wired — the numbers are then calendar days. */
  business_days_available: boolean;
}

export async function pipelineAging(input: {
  tenant_id: string;
  stage?: string;
  owner_persona_id?: string;
  min_business_days?: number;
  now?: Date;
  limit?: number;
}): Promise<AgingReport> {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 2000);
  const rows = await dataService.rows<{
    subject_ref: string; stage: string; owner_persona_id: string | null;
    entered_at: Date; last_activity_at: Date | null;
  }>(
    `SELECT subject_ref, stage, owner_persona_id, entered_at, last_activity_at
       FROM crm.stage_entry
      WHERE tenant_id = $1 AND exited_at IS NULL
        AND ($2::text IS NULL OR stage = $2)
        AND ($3::uuid IS NULL OR owner_persona_id = $3)
      ORDER BY entered_at ASC
      LIMIT ${limit}`,
    [input.tenant_id, input.stage ?? null, input.owner_persona_id ?? null],
  );

  const entries: AgingEntry[] = [];
  for (const r of rows) {
    const entered = new Date(r.entered_at);
    const activity = r.last_activity_at ? new Date(r.last_activity_at) : null;
    const calendar_days_in_stage = Math.floor((now.getTime() - entered.getTime()) / 86_400_000);
    const inStage = businessDays
      ? await businessDays({ tenant_id: input.tenant_id, from: entered, to: now })
      : null;
    const sinceActivity = businessDays && activity
      ? await businessDays({ tenant_id: input.tenant_id, from: activity, to: now })
      : null;

    const entry: AgingEntry = {
      subject_ref: r.subject_ref,
      stage: r.stage,
      owner_persona_id: r.owner_persona_id,
      entered_at: entered.toISOString(),
      last_activity_at: activity ? activity.toISOString() : null,
      business_days_in_stage: inStage,
      business_days_since_activity: sinceActivity,
      calendar_days_in_stage,
    };
    if (input.min_business_days !== undefined) {
      const measure = inStage ?? calendar_days_in_stage;
      if (measure < input.min_business_days) continue;
    }
    entries.push(entry);
  }

  return {
    entries,
    as_of: now.toISOString(),
    // Stated rather than implied: a caller must be able to tell a business-day number
    // from a calendar-day one, because the queue means something different in each.
    business_days_available: businessDays !== null,
  };
}

function kindOf(subject_ref: string): string | null {
  const idx = subject_ref.indexOf(':');
  return idx > 0 ? subject_ref.slice(0, idx) : null;
}
