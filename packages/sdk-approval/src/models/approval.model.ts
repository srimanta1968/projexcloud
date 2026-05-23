/**
 * TypeScript models mirroring approval.* tables per P4-Operational-Billing-DataModel §11.
 */

export type RouteStatus = 'draft' | 'active' | 'deprecated';
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'escalated' | 'timed-out' | 'cancelled';
export type Decision = 'approve' | 'reject';

/**
 * One step in route.steps jsonb. `kind` discriminates:
 *   single       - one approver_persona_id; advances on their decide
 *   m-of-n       - parallel candidates; advances on m approvals or any reject
 *   role         - a role_template_id; routing engine resolves to a persona
 */
export type RouteStepSpec =
  | { name: string; kind: 'single'; approver_persona_id: string; sla_minutes?: number }
  | { name: string; kind: 'm-of-n'; m: number; approvers: string[]; sla_minutes?: number }
  | { name: string; kind: 'role'; role_template_id: string; sla_minutes?: number };

/**
 * Per-persona OOO / delegation rules. If `from`..`to` window covers now,
 * route the approval to `delegate_to` instead of the original approver.
 */
export interface DelegationRule {
  delegate_to: string;
  from?: string;
  to?: string;
}
export type DelegationRules = Record<string, DelegationRule>;

export interface RouteRecord {
  route_id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  kind_pattern: string | null;
  steps: RouteStepSpec[];
  delegation_rules: DelegationRules;
  status: RouteStatus;
  created_at: Date;
}

export interface RequestRecord {
  request_id: string;
  route_id: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  initiator_persona_id: string;
  reason: string | null;
  status: RequestStatus;
  final_decision: Decision | null;
  requested_at: Date;
  resolved_at: Date | null;
}

export interface StepRecord {
  step_id: string;
  request_id: string;
  step_index: number;
  approver_persona_id: string;
  decision: Decision | null;
  reason: string | null;
  sla_deadline: Date | null;
  acted_at: Date | null;
  delegated_from: string | null;
  auto_escalated: boolean;
}

/* ---------------------------------------------------------- DTO inputs */

export interface CreateRouteInput {
  tenant_id: string;
  name: string;
  description?: string;
  kind_pattern?: string;
  steps: RouteStepSpec[];
  delegation_rules?: DelegationRules;
}

export interface SubmitRequestInput {
  tenant_id: string;
  route_id: string;
  subject_kind: string;
  subject_id: string;
  initiator_persona_id: string;
  reason?: string;
}

export interface SubmitRequestResult {
  request: RequestRecord;
  pending_steps: StepRecord[];
}

export interface DecideInput {
  step_id: string;
  decision: Decision;
  reason?: string;
  /** The persona making the decision. Must match step.approver_persona_id or be a valid delegate. */
  acting_persona_id: string;
}

export interface DecideResult {
  step: StepRecord;
  request: RequestRecord;
  next_steps: StepRecord[];
}
