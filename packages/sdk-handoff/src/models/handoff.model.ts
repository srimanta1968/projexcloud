/**
 * sdk-handoff domain model (P15·E2). Mirrors handoff.handoff (migration 001) —
 * the DB CHECK constraint is authoritative for the status set, so the lifecycle
 * uses draft/pending/accepted/rejected/completed/cancelled (NOT the loose prose
 * "proposed/active/closed").
 */

export type HandoffStatus =
  | 'draft'
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'completed'
  | 'cancelled';

/**
 * Allowed status transitions. Terminal states (rejected/completed/cancelled)
 * map to an empty array. A handoff may be cancelled from any non-terminal state.
 */
export const HANDOFF_TRANSITIONS: Record<HandoffStatus, HandoffStatus[]> = {
  draft: ['pending', 'cancelled'],
  pending: ['accepted', 'rejected', 'cancelled'],
  accepted: ['completed', 'cancelled'],
  rejected: [],
  completed: [],
  cancelled: [],
};

/** Maps a target status to the lifecycle event_type emitted on entry. */
export const HANDOFF_TRANSITION_EVENT: Record<HandoffStatus, string | null> = {
  draft: null,
  pending: 'handoff.submitted.v1',
  accepted: 'handoff.accepted.v1',
  rejected: 'handoff.rejected.v1',
  completed: 'handoff.completed.v1',
  cancelled: 'handoff.cancelled.v1',
};

export function isValidTransition(from: HandoffStatus, to: HandoffStatus): boolean {
  return HANDOFF_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface HandoffRecord {
  handoff_id: string;
  tenant_id: string;
  deal_id: string | null;
  from_persona_id: string;
  cs_owner_persona_id: string | null;
  cs_backup_persona_id: string | null;
  kickoff_ref: string | null;
  status: HandoffStatus;
  prework: unknown[];
  promises: unknown[];
  risks: unknown[];
  integrations: unknown[];
  milestones: unknown[];
  reject_reason: string | null;
  workflow_run_id: string | null;
  approval_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  accepted_at: string | null;
  rejected_at: string | null;
  completed_at: string | null;
}

export interface CreateHandoffInput {
  tenant_id: string;
  from_persona_id: string;
  deal_id?: string | null;
  cs_owner_persona_id?: string | null;
  cs_backup_persona_id?: string | null;
  kickoff_ref?: string | null;
  prework?: unknown[];
  promises?: unknown[];
  risks?: unknown[];
  integrations?: unknown[];
  milestones?: unknown[];
  workflow_run_id?: string | null;
  approval_id?: string | null;
  metadata?: Record<string, unknown>;
}

/** Fields editable via updateHandoff while the record is still draft/pending. */
export interface UpdateHandoffInput {
  cs_owner_persona_id?: string | null;
  cs_backup_persona_id?: string | null;
  kickoff_ref?: string | null;
  prework?: unknown[];
  promises?: unknown[];
  risks?: unknown[];
  integrations?: unknown[];
  milestones?: unknown[];
  workflow_run_id?: string | null;
  approval_id?: string | null;
  metadata?: Record<string, unknown>;
}
