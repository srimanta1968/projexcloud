/**
 * Models mirroring hdk_sync.* per P3-Canonical-Privacy-HDK-DataModel §11.2.
 */

export type ConflictPolicy = 'crdt' | 'lww' | 'merge' | 'event-sourcing' | 'human-review';
export type RetentionClass = 'transient' | 'operational' | 'regulated';
export type ReviewStatus = 'open' | 'in-review' | 'resolved' | 'rejected';

export interface EventTypePolicy {
  event_type: string;
  conflict_policy: ConflictPolicy;
  strategy_detail: string | null;
  retention_class: RetentionClass;
  registered_at: Date;
}

export interface ReplayLogRecord {
  batch_id: string;
  device_uuid: string;
  tenant_id: string;
  event_count: number;
  conflict_count: number;
  started_at: Date;
  completed_at: Date | null;
}

export interface ConflictRecord {
  conflict_id: string;
  batch_id: string | null;
  event_type: string;
  conflict_policy: ConflictPolicy;
  strategy_detail: string | null;
  input_a: Record<string, unknown>;
  input_b: Record<string, unknown>;
  resolved: Record<string, unknown> | null;
  escalated_to_human: boolean;
  audit_entry_id: string | null;
  resolved_at: Date | null;
}

export interface HumanReviewTaskRecord {
  task_id: string;
  conflict_id: string;
  assignee_persona_id: string | null;
  status: ReviewStatus;
  resolved_value: Record<string, unknown> | null;
  resolved_at: Date | null;
  created_at: Date;
}

export interface SyncEventEnvelope {
  event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  device_uuid: string;
  persona_id?: string;
  tenant_id: string;
  encounter_id?: string;
  occurred_at: string; // ISO timestamp
}

export interface ResolveConflictInput {
  event_type: string;
  input_a: Record<string, unknown>;
  input_b: Record<string, unknown>;
  batch_id?: string;
}

export interface ResolveConflictResult {
  conflict: ConflictRecord;
  human_review_task?: HumanReviewTaskRecord;
}
