/**
 * TypeScript model mirroring policy.* tables per P2 §8.
 */

export type PolicyStatus = 'draft' | 'active' | 'deprecated' | 'retired';
export type AttributeFetcherSource = 'mdm' | 'projection' | 'inline';
export type DecisionOutcome = 'ALLOW' | 'DENY';

/**
 * IQL expression AST (FR-POL-7). Subset that compiles cleanly to Cedar
 * `permit { ... } when { ... }` terms. Future grammar additions are
 * minor-version-only per PRD Risk R-2.
 */
export type IQLNode =
  | { kind: 'subject_persona'; role: string }
  | { kind: 'subject_bu_ancestor'; bu_id: string }
  | { kind: 'relationship'; type: string; target?: string }
  | { kind: 'encounter'; active?: boolean }
  | { kind: 'and'; left: IQLNode; right: IQLNode }
  | { kind: 'or'; left: IQLNode; right: IQLNode }
  | { kind: 'not'; inner: IQLNode };

export interface CedarTerm {
  effect: 'permit' | 'forbid';
  principal_kind: string;
  action: string;
  resource_kind: string;
  conditions: Record<string, unknown>[];
}

export interface PolicyRecord {
  policy_id: string;
  tenant_id: string | null;
  name: string;
  iql_source: string;
  cedar_compiled: CedarTerm | Record<string, unknown>;
  version: string;
  status: PolicyStatus;
  created_at: Date;
  updated_at: Date;
}

export interface AttributeFetcherRecord {
  fetcher_id: string;
  name: string;
  source: AttributeFetcherSource;
  returns_type: string;
  version: number;
  created_at: Date;
}

export interface DecisionRecord {
  decision_id: string;
  policy_id: string;
  subject_id: string;
  target_id: string | null;
  decision: DecisionOutcome;
  reason: string;
  layers_used: string[];
  projection_version: number;
  decided_at: Date;
}

export interface CreatePolicyInput {
  tenant_id?: string;
  name: string;
  iql_source: string;
  version: string;
}

export interface EvaluatePolicyInput {
  policy_id: string;
  subject_id: string;
  target_id?: string;
  context?: Record<string, unknown>;
}

export interface EvaluatePolicyResult {
  decision: DecisionOutcome;
  reason: string;
  layers_used: string[];
  projection_version: number;
  cached: boolean;
}
