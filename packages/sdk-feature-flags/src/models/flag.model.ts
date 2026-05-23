export type FlagKind = 'boolean' | 'variant' | 'numeric' | 'json';

export interface FlagRecord {
  flag_id: string;
  description: string | null;
  kind: FlagKind;
  default_value: unknown;
  kill_switch: boolean;
  schema_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RolloutRecord {
  rollout_id: string;
  flag_id: string;
  tenant_id: string | null;
  predicate: Record<string, unknown>;
  value: unknown;
  priority: number;
  /** FR-FF-3 percentage bucket (0–100); null = predicate-only. */
  rollout_percent: number | null;
  active: boolean;
  created_at: Date;
}

export interface UpsertFlagInput {
  flag_id: string;
  description?: string;
  kind?: FlagKind;
  default_value?: unknown;
  kill_switch?: boolean;
  schema_ref?: string;
}

export interface UpsertRolloutInput {
  flag_id: string;
  tenant_id?: string;
  predicate?: Record<string, unknown>;
  value: unknown;
  priority?: number;
  /** 0–100 inclusive; null/undefined = predicate-only (no % gate). */
  rollout_percent?: number;
  active?: boolean;
}

export interface EvaluationContext {
  tenant_id?: string;
  persona_id?: string;
  bu_id?: string;
  attributes?: Record<string, unknown>;
}

export interface EvaluationResult {
  flag_id: string;
  resolved_value: unknown;
  matched_rollout_id: string | null;
  kill_switch_engaged: boolean;
}
