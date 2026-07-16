import { dataService } from '@projexlight/db-runtime';
import { emitEvent } from '@projexlight/sdk-audit';
import {
  isValidTransition,
  HANDOFF_TRANSITION_EVENT,
  type CreateHandoffInput,
  type HandoffRecord,
  type HandoffStatus,
  type UpdateHandoffInput,
} from '../models/handoff.model';

/**
 * sdk-handoff service (P15·E2) — Sales→Delivery handoff CRUD + status lifecycle.
 *
 * Lifecycle: draft -> pending -> accepted/rejected -> completed; a handoff may be
 * cancelled from any non-terminal state. Every transition is validated against
 * HANDOFF_TRANSITIONS, stamps the matching timestamp, and emits a lifecycle
 * event through sdk-audit. All queries are tenant-scoped.
 */

const HANDOFF_AUDIT_POOL = process.env.HANDOFF_AUDIT_POOL || 'admin-default';

const HANDOFF_COLS = `
  handoff_id, tenant_id, deal_id, from_persona_id, cs_owner_persona_id,
  cs_backup_persona_id, kickoff_ref, status, prework, promises, risks,
  integrations, milestones, reject_reason, workflow_run_id, approval_id,
  metadata, created_at, updated_at, submitted_at, accepted_at, rejected_at,
  completed_at`;

/** Target status -> the timestamp column stamped on entry (null = none). */
const TRANSITION_TIMESTAMP: Record<HandoffStatus, string | null> = {
  draft: null,
  pending: 'submitted_at',
  accepted: 'accepted_at',
  rejected: 'rejected_at',
  completed: 'completed_at',
  cancelled: null,
};

/** Thrown when a requested status transition is not allowed from the current state. */
export class InvalidHandoffTransition extends Error {
  constructor(public from: HandoffStatus, public to: HandoffStatus) {
    super(`[sdk-handoff] invalid transition ${from} -> ${to}`);
    this.name = 'InvalidHandoffTransition';
  }
}

async function emitHandoffEvent(
  event_type: string,
  rec: HandoffRecord,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await emitEvent({
    event_type,
    pool_index: HANDOFF_AUDIT_POOL,
    actor_kind: 'service',
    actor_id: 'sdk-handoff',
    tenant_id: rec.tenant_id,
    subject_kind: 'handoff.handoff',
    subject_id: rec.handoff_id,
    payload: {
      handoff_id: rec.handoff_id,
      deal_id: rec.deal_id,
      status: rec.status,
      from_persona_id: rec.from_persona_id,
      cs_owner_persona_id: rec.cs_owner_persona_id,
      ...extra,
    },
  });
}

/** Create a handoff in status 'draft'. Emits handoff.created.v1. */
export async function createHandoff(input: CreateHandoffInput): Promise<HandoffRecord> {
  const rec = await dataService.one<HandoffRecord>(
    `INSERT INTO handoff.handoff
       (tenant_id, deal_id, from_persona_id, cs_owner_persona_id, cs_backup_persona_id,
        kickoff_ref, prework, promises, risks, integrations, milestones,
        workflow_run_id, approval_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6,
             COALESCE($7::jsonb, '[]'::jsonb), COALESCE($8::jsonb, '[]'::jsonb),
             COALESCE($9::jsonb, '[]'::jsonb), COALESCE($10::jsonb, '[]'::jsonb),
             COALESCE($11::jsonb, '[]'::jsonb), $12, $13,
             COALESCE($14::jsonb, '{}'::jsonb))
     RETURNING ${HANDOFF_COLS}`,
    [
      input.tenant_id,
      input.deal_id ?? null,
      input.from_persona_id,
      input.cs_owner_persona_id ?? null,
      input.cs_backup_persona_id ?? null,
      input.kickoff_ref ?? null,
      input.prework ? JSON.stringify(input.prework) : null,
      input.promises ? JSON.stringify(input.promises) : null,
      input.risks ? JSON.stringify(input.risks) : null,
      input.integrations ? JSON.stringify(input.integrations) : null,
      input.milestones ? JSON.stringify(input.milestones) : null,
      input.workflow_run_id ?? null,
      input.approval_id ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  if (!rec) throw new Error('[sdk-handoff] insert returned no row');
  await emitHandoffEvent('handoff.created.v1', rec);
  return rec;
}

/** Fetch a single tenant-scoped handoff, or null when not found. */
export async function getHandoff(tenant_id: string, handoff_id: string): Promise<HandoffRecord | null> {
  return dataService.one<HandoffRecord>(
    `SELECT ${HANDOFF_COLS} FROM handoff.handoff WHERE tenant_id = $1 AND handoff_id = $2`,
    [tenant_id, handoff_id],
  );
}

/** List tenant-scoped handoffs, optionally filtered by status / deal. */
export async function listHandoffs(
  tenant_id: string,
  opts: { status?: string; deal_id?: string; limit?: number; offset?: number } = {},
): Promise<HandoffRecord[]> {
  return dataService.rows<HandoffRecord>(
    `SELECT ${HANDOFF_COLS}
       FROM handoff.handoff
      WHERE tenant_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::uuid IS NULL OR deal_id = $3)
      ORDER BY updated_at DESC
      LIMIT $4 OFFSET $5`,
    [tenant_id, opts.status ?? null, opts.deal_id ?? null, opts.limit ?? 50, opts.offset ?? 0],
  );
}

/**
 * Update editable fields while the handoff is still draft/pending. Returns null
 * when the record does not exist OR is already in a terminal/accepted state
 * (callers distinguish via getHandoff). Emits handoff.updated.v1.
 */
export async function updateHandoff(
  tenant_id: string,
  handoff_id: string,
  patch: UpdateHandoffInput,
): Promise<HandoffRecord | null> {
  const rec = await dataService.one<HandoffRecord>(
    `UPDATE handoff.handoff SET
        cs_owner_persona_id  = COALESCE($3, cs_owner_persona_id),
        cs_backup_persona_id = COALESCE($4, cs_backup_persona_id),
        kickoff_ref          = COALESCE($5, kickoff_ref),
        prework              = COALESCE($6::jsonb, prework),
        promises             = COALESCE($7::jsonb, promises),
        risks                = COALESCE($8::jsonb, risks),
        integrations         = COALESCE($9::jsonb, integrations),
        milestones           = COALESCE($10::jsonb, milestones),
        workflow_run_id      = COALESCE($11, workflow_run_id),
        approval_id          = COALESCE($12, approval_id),
        metadata             = COALESCE($13::jsonb, metadata),
        updated_at           = now()
      WHERE tenant_id = $1 AND handoff_id = $2 AND status IN ('draft','pending')
      RETURNING ${HANDOFF_COLS}`,
    [
      tenant_id,
      handoff_id,
      patch.cs_owner_persona_id ?? null,
      patch.cs_backup_persona_id ?? null,
      patch.kickoff_ref ?? null,
      patch.prework ? JSON.stringify(patch.prework) : null,
      patch.promises ? JSON.stringify(patch.promises) : null,
      patch.risks ? JSON.stringify(patch.risks) : null,
      patch.integrations ? JSON.stringify(patch.integrations) : null,
      patch.milestones ? JSON.stringify(patch.milestones) : null,
      patch.workflow_run_id ?? null,
      patch.approval_id ?? null,
      patch.metadata ? JSON.stringify(patch.metadata) : null,
    ],
  );
  if (rec) await emitHandoffEvent('handoff.updated.v1', rec);
  return rec;
}

/**
 * Transition a handoff to a new status. Validates the transition against
 * HANDOFF_TRANSITIONS, stamps the matching lifecycle timestamp, records a
 * reject_reason when rejecting, and emits the lifecycle event.
 *
 * @returns the updated record, or null when the handoff is not found.
 * @throws InvalidHandoffTransition when the transition is not allowed.
 */
export async function transitionHandoff(
  tenant_id: string,
  handoff_id: string,
  to: HandoffStatus,
  opts: { reject_reason?: string } = {},
): Promise<HandoffRecord | null> {
  const current = await dataService.one<{ status: HandoffStatus }>(
    `SELECT status FROM handoff.handoff WHERE tenant_id = $1 AND handoff_id = $2`,
    [tenant_id, handoff_id],
  );
  if (!current) return null;
  if (!isValidTransition(current.status, to)) {
    throw new InvalidHandoffTransition(current.status, to);
  }

  const tsCol = TRANSITION_TIMESTAMP[to];
  const setTimestamp = tsCol ? `, ${tsCol} = now()` : '';
  const rec = await dataService.one<HandoffRecord>(
    `UPDATE handoff.handoff
        SET status = $3,
            reject_reason = CASE WHEN $3 = 'rejected' THEN $4 ELSE reject_reason END,
            updated_at = now()${setTimestamp}
      WHERE tenant_id = $1 AND handoff_id = $2
      RETURNING ${HANDOFF_COLS}`,
    [tenant_id, handoff_id, to, opts.reject_reason ?? null],
  );
  if (!rec) return null;

  const eventType = HANDOFF_TRANSITION_EVENT[to];
  if (eventType) {
    await emitHandoffEvent(eventType, rec, to === 'rejected' ? { reject_reason: rec.reject_reason } : {});
  }
  return rec;
}
