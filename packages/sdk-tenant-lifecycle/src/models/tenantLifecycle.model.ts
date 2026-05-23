/**
 * Models mirroring tenant_lifecycle.* per P4 DataModel §12.
 *
 * The task-spec state set is the operational FSM that sdk-billing dunning
 * and ops drive; the PRD §5.9 superset (provisioned/trial) is reserved for
 * a follow-up onboarding flow.
 */

export type TenantLifecycleState =
  | 'active'
  | 'suspended'
  | 'offboarding'
  | 'offboarded'
  | 'sandbox';

export interface TenantLifecycleStateRecord {
  tenant_id: string;
  current_state: TenantLifecycleState;
  suspended_reason: string | null;
  sandbox_parent_tenant_id: string | null;
  offboard_deadline_at: Date | null;
  updated_at: Date;
  updated_by: string | null;
}

export interface TenantLifecycleEventRecord {
  event_id: string;
  tenant_id: string;
  from_state: TenantLifecycleState | null;
  to_state: TenantLifecycleState;
  reason: string | null;
  actor_id: string | null;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

export interface TenantLifecycleSandboxRecord {
  sandbox_tenant_id: string;
  parent_tenant_id: string;
  created_at: Date;
  expires_at: Date | null;
  sanitization_policy: string;
}

export interface TransitionInput {
  tenant_id: string;
  to_state: TenantLifecycleState;
  reason?: string;
  actor_id: string;
  /** For offboarding transitions, set a deadline at which the tenant flips
   *  to offboarded (sdk-data-rights shred-and-certify completes after this). */
  offboard_deadline_at?: Date;
}

export interface CreateSandboxInput {
  parent_tenant_id: string;
  expires_at?: Date;
  sanitization_policy?: string;
  actor_id: string;
}
