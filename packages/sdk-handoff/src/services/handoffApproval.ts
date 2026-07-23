import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { getHandoff, transitionHandoff } from './handoffService';
import type { HandoffRecord } from '../models/handoff.model';

/**
 * @projexlight/sdk-handoff — CS accept/reject gate via sdk-approval (P15·E2, TK-3648).
 *
 * The accept/reject decision on a Sales→Delivery handoff is delegated to sdk-approval —
 * no new gate is built here. requestHandoffApproval() files an approval request whose
 * subject is the handoff (submitting the draft for CS review → status 'pending') and
 * stores its id in handoff.approval_id. When sdk-approval resolves, recordHandoffDecision()
 * maps the outcome onto the handoff lifecycle (approved → accepted/active, rejected →
 * rejected) and the existing transition path emits the lifecycle event.
 *
 * The approval request creator is pluggable (setHandoffApprovalCreator): the gateway wires
 * it to sdk-approval.submitRequest against a configured handoff route; the default returns a
 * synthetic UUID ref so the SDK carries no hard sdk-approval dependency and the happy path
 * is test-safe without seeding an approval route.
 */

export type HandoffDecision = 'approved' | 'rejected';

export interface HandoffApprovalContext {
  tenant_id: string;
  handoff_id: string;
  from_persona_id: string;
  deal_id: string | null;
}
/** Files the approval request (subject = handoff) and returns its id. */
export type HandoffApprovalCreator = (ctx: HandoffApprovalContext) => Promise<{ approval_id: string }>;

// Default: mint a synthetic request id (a real UUID so approval_id's column accepts it); the
// request is considered pending until decided. The gateway overrides this with sdk-approval.
let _approvalCreator: HandoffApprovalCreator = async () => ({ approval_id: randomUUID() });
export function setHandoffApprovalCreator(creator: HandoffApprovalCreator): void { _approvalCreator = creator; }
export function _resetHandoffApprovalCreator(): void {
  _approvalCreator = async () => ({ approval_id: randomUUID() });
}

export interface RequestApprovalResult { handoff: HandoffRecord; approval_id: string; }

/**
 * File a CS accept/reject approval for a handoff (delegated to sdk-approval) and submit it
 * for review. A draft handoff moves draft → pending; an already-pending one is left as-is
 * (idempotent re-request). The approval id is stored on the handoff. Returns null if the
 * handoff does not exist for the tenant.
 */
export async function requestHandoffApproval(tenantId: string, handoffId: string): Promise<RequestApprovalResult | null> {
  const existing = await getHandoff(tenantId, handoffId);
  if (!existing) return null;

  const { approval_id } = await _approvalCreator({
    tenant_id: tenantId,
    handoff_id: handoffId,
    from_persona_id: existing.from_persona_id,
    deal_id: existing.deal_id ?? null,
  });
  await dataService.rows(
    `UPDATE handoff.handoff SET approval_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND handoff_id = $2`,
    [tenantId, handoffId, approval_id],
  );

  // Submit for CS review. draft → pending; keep any later state untouched.
  const handoff = existing.status === 'draft'
    ? (await transitionHandoff(tenantId, handoffId, 'pending')) ?? existing
    : (await getHandoff(tenantId, handoffId)) ?? existing;

  return { handoff, approval_id };
}

/**
 * Record the sdk-approval decision on a handoff: 'approved' → accepted (the delivery team
 * owns it), 'rejected' → rejected (with an optional reason). The handoff transition path
 * validates the move and emits the lifecycle event (handoff.accepted/rejected.v1). Returns
 * null if the handoff does not exist; throws InvalidHandoffTransition if it is not pending.
 */
export async function recordHandoffDecision(
  tenantId: string,
  handoffId: string,
  decision: HandoffDecision,
  rejectReason?: string,
): Promise<HandoffRecord | null> {
  const target = decision === 'approved' ? 'accepted' : 'rejected';
  return transitionHandoff(tenantId, handoffId, target, { reject_reason: rejectReason });
}
