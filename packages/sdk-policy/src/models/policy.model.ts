/**
 * TypeScript model mirroring policy.* tables per P2 §8.
 */

import type { ConsentReceiptInput, Obligations } from '@projexlight/contracts';

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
  /**
   * P10/E1: obligations this bundle attaches to an ALLOW decision. Optional —
   * a bundle without obligations yields plain allow/deny (pre-P10 behaviour).
   */
  obligations?: Obligations | null;
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
  /**
   * P10/E1: obligations attached to this decision (mask/filter/audit/ttl),
   * persisted so policy observability can replay what was enforced. Optional —
   * absent for pre-P10 decisions.
   */
  obligations?: Obligations | null;
}

export interface CreatePolicyInput {
  tenant_id?: string;
  name: string;
  iql_source: string;
  version: string;
  /** P10/E1: optional obligations attached to ALLOW decisions of this bundle. */
  obligations?: Obligations;
}

export interface EvaluatePolicyInput {
  policy_id: string;
  subject_id: string;
  target_id?: string;
  context?: Record<string, unknown>;
  /**
   * P10/E3: the purpose the access is being made for (e.g. a HIPAA TPO code).
   * Threaded into the decision so consent gating can apply.
   */
  purpose?: string;
  /**
   * P10/E3: marks the target as a purpose-bound resource. When true, a valid
   * consent receipt for `purpose` is REQUIRED — absent/expired/revoked consent
   * fails closed (DENY, reason=consent_absent) regardless of the policy verdict.
   */
  purpose_bound?: boolean;
  /**
   * P10/E3: the subject's active consent receipts (supplied by the gateway /
   * resolver from sdk-consent). Keeps sdk-policy decoupled from sdk-consent.
   */
  consent_receipts?: ConsentReceiptInput[];
}

export interface EvaluatePolicyResult {
  decision: DecisionOutcome;
  reason: string;
  layers_used: string[];
  projection_version: number;
  cached: boolean;
  /**
   * P10/E1: optional obligations the caller MUST enforce server-side before
   * serializing results (mask_fields, row_filter, audit_level, ttl_seconds).
   * Absent obligations preserve today's allow/deny behaviour exactly.
   */
  obligations?: Obligations;
}
