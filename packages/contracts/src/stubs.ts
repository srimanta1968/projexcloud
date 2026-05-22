/**
 * Forward-looking type stubs per FR-CTR-8 (P1-Foundation-Spine §4.5).
 * Namespaces are reserved here so consumers can import without a circular-
 * dependency rewrite when concrete types land in later phases.
 *
 * Phase mapping:
 *   P2  · IQLGrammar, ReBACTraversalBudget
 *   P3  · ConflictPolicy
 *   P6A · AgentIdentity
 *   P6B · SemanticObject, SemanticRelation, CapabilityGraph, Ontology,
 *         SemanticIntent, SemanticPolicy
 *   P7  · PoolFederationManifest (full runtime; hooks already in routing schema)
 */

// ---- P2 stubs ------------------------------------------------------------

/** ABAC query language grammar reserved for P2 sdk-policy. */
export interface IQLGrammar {
  __reserved_for: 'P2.sdk-policy';
}

/** ReBAC traversal budget reserved for P2 sdk-rebac. */
export interface ReBACTraversalBudget {
  __reserved_for: 'P2.sdk-rebac';
  max_hops?: number;
  max_edges?: number;
  timeout_ms?: number;
}

// ---- P3 stubs ------------------------------------------------------------

/**
 * Sync conflict-resolution policy reserved for P3 sdk-sync / hdk-sync.
 * Distinct from `ConflictPolicy` in events.ts which is the event-bus conflict
 * mode; this one applies to offline-sync row reconciliation.
 */
export interface SyncConflictPolicy {
  __reserved_for: 'P3.sdk-sync';
}

// ---- P6A stubs -----------------------------------------------------------

/** Agent identity for sandboxed AI agents — reserved for P6A. */
export interface AgentIdentity {
  __reserved_for: 'P6A.sdk-agent-runtime';
}

// ---- P6B stubs -----------------------------------------------------------

export interface SemanticObject {
  __reserved_for: 'P6B.sdk-semantic';
}
export interface SemanticRelation {
  __reserved_for: 'P6B.sdk-semantic';
}
export interface CapabilityGraph {
  __reserved_for: 'P6B.sdk-semantic';
}
export interface Ontology {
  __reserved_for: 'P6B.sdk-semantic';
}
export interface SemanticIntent {
  __reserved_for: 'P6B.sdk-semantic';
}
export interface SemanticPolicy {
  __reserved_for: 'P6B.sdk-semantic';
}

// ---- P7 stubs ------------------------------------------------------------

/**
 * Pool federation manifest reserved for P7. Hooks are already in the routing
 * schema (`routing.pool_federation_manifest`); the runtime client lands in P7.
 */
export interface PoolFederationManifest {
  __reserved_for: 'P7.sdk-pool-router';
  manifest_id: string;
  tenant_id: string;
  pool_indexes: string[];
  query_class: 'resolver' | 'dsar' | 'analytics' | 'lineage';
}
