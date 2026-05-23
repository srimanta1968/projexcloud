/**
 * TypeScript model mirroring workflow.* tables per P4-Operational-Billing-DataModel §7.
 */

export type DefinitionStatus = 'draft' | 'active' | 'deprecated';
export type RunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'compensated' | 'terminated';
export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'compensated' | 'skipped';
export type CompensationStatus = 'pending' | 'executing' | 'succeeded' | 'failed';

export interface StepSpec {
  name: string;
  /** Optional compensation kind — names a registered compensator function. */
  compensate?: string;
}

export interface DefinitionRecord {
  workflow_def_id: string;
  name: string;
  version: string;
  namespace: string;
  step_specs: StepSpec[];
  status: DefinitionStatus;
  created_at: Date;
}

export interface RunRecord {
  run_id: string;
  workflow_def_id: string;
  tenant_id: string | null;
  persona_id: string | null;
  trace_id: string | null;
  envelope: WorkflowEnvelope;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: RunStatus;
  started_at: Date;
  completed_at: Date | null;
  error_message: string | null;
  /** Index of the next step_specs[] entry to execute on resume. */
  current_idx?: number;
  /** Wall-clock target at which a paused run becomes eligible for resume. */
  wake_at?: Date | null;
  /** Diagnostic: identity of the worker that last claimed this run. */
  claimed_by?: string | null;
  claimed_at?: Date | null;
}

export interface StepRecord {
  step_id: string;
  run_id: string;
  idx: number;
  name: string;
  status: StepStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  started_at: Date | null;
  completed_at: Date | null;
  error_message: string | null;
  /** For sleep:<ms> steps, the wall-clock target when the run should resume. */
  wake_at?: Date | null;
}

export interface CompensationRecord {
  compensation_id: string;
  step_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: CompensationStatus;
  executed_at: Date | null;
  error_message: string | null;
}

/**
 * Envelope context propagated through every step (FR-WFL-1).
 * Steps read this via WorkflowContext.envelope; downstream SDK calls
 * inherit org/app/tenant/persona/trace_id without manual plumbing.
 */
export interface WorkflowEnvelope {
  org_id?: string | null;
  app_id?: string | null;
  tenant_id?: string | null;
  bu_id?: string | null;
  persona_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  projection_version?: number;
  actor?: { kind: 'human' | 'service' | 'agent' | 'support_impersonator'; id?: string };
}

export interface RegisterDefinitionInput {
  name: string;
  version?: string;
  namespace?: string;
  step_specs: StepSpec[];
}

export interface StartRunInput {
  name: string;
  version?: string;
  namespace?: string;
  envelope?: WorkflowEnvelope;
  input?: Record<string, unknown>;
}

export interface StartRunResult {
  run_id: string;
  status: RunStatus;
  steps: StepRecord[];
  output: Record<string, unknown> | null;
}

export interface SignalInput {
  signal_name: string;
  payload?: Record<string, unknown>;
}

export interface QueryResult {
  run: RunRecord;
  steps: StepRecord[];
  compensations: CompensationRecord[];
}
