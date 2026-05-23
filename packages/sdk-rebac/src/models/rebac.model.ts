/**
 * TypeScript model mirroring rebac.* tables per P2 §9.
 */

export type RelationshipStatus = 'open' | 'active' | 'suspended' | 'terminated' | 'expired';
export type DecisionOutcome = 'allow' | 'deny';

/**
 * ReBAC traversal budget (FR-REB-6). Default depth cap 4 per PRD R-2.
 * Visit cap defends against pathological cycles even when within depth.
 */
export interface TraversalBudget {
  depth_cap: number;
  visit_cap: number;
}

export const DEFAULT_BUDGET: TraversalBudget = { depth_cap: 4, visit_cap: 1024 };

export interface RelationshipRecord {
  relationship_id: string;
  kind: string;
  persona_a: string;
  persona_b: string;
  scope: Record<string, unknown>;
  status: RelationshipStatus;
  consent_ref: string | null;
  expires_at: Date | null;
  reattest_due_at: Date | null;
  cross_tenant: boolean;
  created_at: Date;
  terminated_at: Date | null;
}

export interface CreateRelationshipInput {
  kind: string;
  persona_a: string;
  persona_b: string;
  scope?: Record<string, unknown>;
  consent_ref?: string;
  expires_at?: string;
  reattest_due_at?: string;
  cross_tenant?: boolean;
}

export interface UpdateRelationshipScopeInput {
  scope?: Record<string, unknown>;
  status?: RelationshipStatus;
}

export interface CheckRelationshipInput {
  subject_persona_id: string;
  target_persona_id: string;
  kind: string;
  budget?: TraversalBudget;
}

export interface CheckRelationshipResult {
  decision: DecisionOutcome;
  reason: string;
  traversal_depth: number;
  budget_used: { visits: number; depth: number };
  cached: boolean;
}
