/**
 * Models mirroring data_rights.* tables per P3-Canonical-Privacy-HDK-DataModel §7.1.
 */

export type DsarKind =
  | 'access'
  | 'erasure'
  | 'rectification'
  | 'restriction'
  | 'objection'
  | 'portability';

export type DsarStatus =
  | 'submitted'
  | 'identity-verified'
  | 'approval-pending'
  | 'grace-period'
  | 'executing'
  | 'certificate-issued'
  | 'audited'
  | 'rejected';

export type ApprovalPolicy = 'auto' | 'manager-approval' | 'cross-tenant-approval';

export type ExecutionAction =
  | 'shred-person-key'
  | 'shred-persona-key'
  | 'shred-encounter-key'
  | 'export'
  | 'rectify';

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type ReconciliationState = 'green' | 'red';

export interface PersonPoolResidencyRecord {
  residency_id: string;
  person_id: string;
  pool_index: string;
  /** Null for platform-scoped data (e.g., device.person_link). Tenant-bound for everything else. */
  tenant_id: string | null;
  data_classes: string[];
  first_touched_at: Date;
  last_touched_at: Date;
  last_reconciled_at: Date | null;
}

export interface DsarRequestRecord {
  request_id: string;
  person_id: string;
  tenant_id: string | null;
  kind: DsarKind;
  jurisdiction: string;
  sla_deadline: Date;
  status: DsarStatus;
  submitted_at: Date;
  verified_at: Date | null;
  approved_at: Date | null;
  grace_until: Date | null;
  executed_at: Date | null;
  certificate_at: Date | null;
  approval_policy: ApprovalPolicy;
  approval_ref: string | null;
}

export interface ExecutionRecord {
  execution_id: string;
  request_id: string;
  pool_index: string;
  action: ExecutionAction;
  shred_target_key_id: string | null;
  status: ExecutionStatus;
  started_at: Date | null;
  completed_at: Date | null;
  audit_entry_id: string | null;
  error_detail: string | null;
}

export interface CertificateRecord {
  certificate_id: string;
  request_id: string;
  format: 'pdf' | 'jsonl';
  artifact_s3_key: string | null;
  shred_proofs: Record<string, string>;
  signed_by_audit_entry_id: string | null;
  issued_at: Date;
}

export interface ReconciliationRunRecord {
  run_id: string;
  started_at: Date;
  completed_at: Date | null;
  discrepancies: Array<{
    person_id: string;
    pool_index: string;
    expected: string[];
    actual: string[];
  }>;
  state: ReconciliationState;
}

export interface TouchResidencyInput {
  person_id: string;
  pool_index: string;
  /** Null = platform-scoped (one row per person+pool); set = tenant-scoped. */
  tenant_id: string | null;
  data_classes: string[];
}

export interface SubmitRequestInput {
  person_id: string;
  tenant_id?: string;
  kind: DsarKind;
  jurisdiction?: string;
  approval_policy?: ApprovalPolicy;
}
