import { dataService } from '@projexlight/db-runtime';

/**
 * A committed next step for ANY subject, and a save-gate that says exactly what is
 * missing (P16 · EP-380 · PCF-07-1).
 *
 * The discipline is the product: somebody owns it, by a specific time, for a stated
 * reason, with a stated result that has to be true afterwards. Five fields, all
 * required, because each one removes a way for work to stall invisibly:
 *
 *   action_type       — a call and a proposal are not the same commitment.
 *   owner_persona_id  — "the team will follow up" is nobody following up.
 *   due_at            — an EXACT instant, not a day. "Tuesday" is not a commitment
 *                       anybody can be late for, and a queue of undated intentions is
 *                       a wish list.
 *   purpose           — why this step exists.
 *   intended_outcome  — what must be TRUE afterwards. Without it, an action is closed
 *                       because it happened, and a pile of things that happened is not
 *                       progress.
 *
 * THE REFUSAL IS STRUCTURED. A save-gate that answers "next action incomplete" forces
 * the user to guess which of five fields is wrong, so they fill the form again and
 * guess again. Every missing element is returned individually, with the field name a
 * client can attach it to, and it is enforced HERE rather than in the form — a client
 * check is a courtesy, and anything reachable by an API call will eventually be called
 * by something that is not that form.
 *
 * The legacy deal-scoped nextActionService is untouched; this is the general case, and
 * deal actions are simply subjects whose ref is `deal:<uuid>`.
 */

export const ACTION_TYPES = [
  'call', 'email', 'meeting', 'task', 'linkedin', 'sms', 'proposal', 'other',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface SubjectNextAction {
  next_action_id: string;
  tenant_id: string;
  subject_ref: string;
  subject_kind: string | null;
  deal_id: string | null;
  action_type: ActionType;
  owner_persona_id: string | null;
  due_at: string;
  purpose: string | null;
  intended_outcome: string | null;
  outcome: string | null;
  status: 'open' | 'completed' | 'cancelled';
  completed_at: string | null;
}

const COLS = `next_action_id, tenant_id, subject_ref, subject_kind, deal_id, action_type,
       owner_persona_id, due_at, purpose, intended_outcome, outcome, status, completed_at`;

/** One missing element of the commitment, named so a client can render it in place. */
export interface MissingElement {
  field: string;
  message: string;
}

export interface SaveGateResult {
  allowed: boolean;
  subject_ref: string;
  /** Empty when allowed. Never collapsed into a single string. */
  missing: MissingElement[];
  next_action_id: string | null;
}

export class SaveGateRefused extends Error {
  readonly code = 'NEXT_ACTION_INCOMPLETE';
  constructor(readonly subject_ref: string, readonly missing: MissingElement[]) {
    super(
      `this subject cannot be saved until its next action is complete: ` +
        missing.map((m) => m.field).join(', '),
    );
    this.name = 'SaveGateRefused';
  }
}

export class InvalidNextAction extends Error {
  readonly code = 'VALIDATION_ERROR';
  constructor(readonly missing: MissingElement[]) {
    super(missing.map((m) => m.message).join('; '));
    this.name = 'InvalidNextAction';
  }
}

export interface SetSubjectNextActionInput {
  tenant_id: string;
  subject_ref: string;
  subject_kind?: string;
  action_type?: string;
  owner_persona_id?: string | null;
  due_at?: Date | string | null;
  purpose?: string | null;
  intended_outcome?: string | null;
  deal_id?: string | null;
}

/**
 * Validate the five elements and say which are missing — all of them, in one pass.
 *
 * Returning at the first problem is what turns a form into a guessing game: the user
 * fixes one field, submits, and is told about the next one.
 */
export function validate(input: SetSubjectNextActionInput): MissingElement[] {
  const missing: MissingElement[] = [];
  const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  if (!ACTION_TYPES.includes(input.action_type as ActionType)) {
    missing.push({
      field: 'action_type',
      message: `action_type must be one of ${ACTION_TYPES.join(', ')} — a call and a proposal are different commitments`,
    });
  }
  if (!text(input.owner_persona_id)) {
    missing.push({
      field: 'owner_persona_id',
      message: 'a next action needs a named owner — "the team will follow up" is nobody following up',
    });
  }
  const due = input.due_at instanceof Date ? input.due_at
    : typeof input.due_at === 'string' ? new Date(input.due_at) : null;
  if (!due || Number.isNaN(due.getTime())) {
    missing.push({
      field: 'due_at',
      message: 'a next action needs an exact due date and time — a day is not something anybody can be late for',
    });
  }
  if (!text(input.purpose)) {
    missing.push({ field: 'purpose', message: 'say why this step exists' });
  }
  if (!text(input.intended_outcome)) {
    missing.push({
      field: 'intended_outcome',
      message: 'say what must be true afterwards — otherwise the action gets closed because it happened, which is not progress',
    });
  }
  return missing;
}

export async function setSubjectNextAction(
  input: SetSubjectNextActionInput,
): Promise<SubjectNextAction> {
  const missing = validate(input);
  // Server-side, always. A client check is a courtesy; anything reachable by an API
  // call will eventually be called by something that is not that form.
  if (missing.length > 0) throw new InvalidNextAction(missing);

  const due = input.due_at instanceof Date ? input.due_at : new Date(input.due_at as string);
  return dataService.tx(async (q) => {
    // Superseding, not stacking: one open action per subject is the whole point, so
    // committing to a new step closes the old one rather than queueing behind it.
    await q(
      `UPDATE crm.next_action SET status = 'cancelled', updated_at = now()
        WHERE tenant_id = $1 AND subject_ref = $2 AND status = 'open'`,
      [input.tenant_id, input.subject_ref],
    );
    const row = await q<SubjectNextAction>(
      `INSERT INTO crm.next_action
          (tenant_id, subject_ref, subject_kind, deal_id, action_type, owner_persona_id,
           due_at, purpose, intended_outcome, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'open')
       RETURNING ${COLS}`,
      [
        input.tenant_id, input.subject_ref, input.subject_kind ?? kindOf(input.subject_ref),
        input.deal_id ?? await existingDealId(q, input.tenant_id, input.subject_ref),
        input.action_type,
        input.owner_persona_id, due, (input.purpose as string).trim(),
        (input.intended_outcome as string).trim(),
      ],
    );
    return row.rows[0];
  });
}

export async function getOpenSubjectNextAction(
  tenant_id: string, subject_ref: string,
): Promise<SubjectNextAction | null> {
  return dataService.one<SubjectNextAction>(
    `SELECT ${COLS} FROM crm.next_action
      WHERE tenant_id = $1 AND subject_ref = $2 AND status = 'open'`,
    [tenant_id, subject_ref],
  );
}

export async function completeSubjectNextAction(input: {
  tenant_id: string; subject_ref: string; outcome?: string;
}): Promise<SubjectNextAction | null> {
  return dataService.one<SubjectNextAction>(
    `UPDATE crm.next_action
        SET status = 'completed', completed_at = now(), outcome = $3, updated_at = now()
      WHERE tenant_id = $1 AND subject_ref = $2 AND status = 'open'
      RETURNING ${COLS}`,
    [input.tenant_id, input.subject_ref, input.outcome ?? null],
  );
}

/**
 * Can this subject be saved?
 *
 * Applies to a lead, a contact, a ticket and a deal alike — the subject_ref carries
 * the kind, and the gate does not care which. Missing elements are returned
 * INDIVIDUALLY so a client renders each one against the field it belongs to.
 */
export async function checkSubjectSaveGate(
  tenant_id: string, subject_ref: string,
): Promise<SaveGateResult> {
  const open = await getOpenSubjectNextAction(tenant_id, subject_ref);
  if (!open) {
    return {
      allowed: false,
      subject_ref,
      missing: [{
        field: 'next_action',
        message: 'this subject has no open next action — commit to a next step before saving',
      }],
      next_action_id: null,
    };
  }
  const missing = validate({
    tenant_id,
    subject_ref,
    action_type: open.action_type,
    owner_persona_id: open.owner_persona_id,
    due_at: open.due_at,
    purpose: open.purpose,
    intended_outcome: open.intended_outcome,
  });
  return {
    allowed: missing.length === 0,
    subject_ref,
    missing,
    next_action_id: open.next_action_id,
  };
}

/** Throws the STRUCTURED refusal, so a handler can hand the list straight back. */
export async function assertSubjectSaveGate(
  tenant_id: string, subject_ref: string,
): Promise<void> {
  const gate = await checkSubjectSaveGate(tenant_id, subject_ref);
  if (!gate.allowed) throw new SaveGateRefused(subject_ref, gate.missing);
}

/* -------------------------------------------------------------- helpers */

/**
 * `lead:123`, `deal:<uuid>`, `ticket:abc` — the prefix is the kind.
 *
 * Parsed rather than required as a separate field so a caller cannot send a ref and a
 * kind that disagree, which is the sort of mismatch nobody notices until a report
 * counts the same subject twice.
 */
function kindOf(subject_ref: string): string | null {
  const idx = subject_ref.indexOf(':');
  return idx > 0 ? subject_ref.slice(0, idx) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Keeps the legacy deal FK populated for deal subjects, so old deal-scoped readers keep
 * working — but ONLY when the deal actually exists.
 *
 * Setting it blindly from the ref turns a generic subject reference into a hard foreign
 * key: a caller naming a deal that is gone (or one that lives in another system behind
 * the same ref shape) would get an opaque constraint error instead of an action. The
 * subject_ref is the identity; the FK is a convenience for existing queries, and a
 * convenience must not be able to refuse the write.
 */
async function existingDealId(
  q: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
  tenant_id: string,
  subject_ref: string,
): Promise<string | null> {
  if (kindOf(subject_ref) !== 'deal') return null;
  const id = subject_ref.slice(subject_ref.indexOf(':') + 1);
  if (!UUID_RE.test(id)) return null;
  const found = await q<{ deal_id: string }>(
    `SELECT deal_id FROM crm.deal WHERE deal_id = $1 AND tenant_id = $2`,
    [id, tenant_id],
  );
  return found.rows.length > 0 ? id : null;
}
