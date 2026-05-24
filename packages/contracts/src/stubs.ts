/**
 * Forward-looking type stubs per FR-CTR-8 (P1-Foundation-Spine §4.5).
 * Namespaces are reserved here so consumers can import without a circular-
 * dependency rewrite when concrete types land in later phases.
 *
 * Phase mapping:
 *   P2  · IQLGrammar, ReBACTraversalBudget
 *   P3  · ConflictPolicy
 *   P6A · AgentIdentity
 *   P6B · concrete types now live in p6b-knowledge.ts — stubs retired
 *   P7  · concrete types now live in p7-field.ts — stubs retired
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

// ---- P6B types now live in p6b-knowledge.ts (landed) ---------------------

// ---- P7 types now live in p7-field.ts (landed) --------------------------
// PoolFederationManifest moved to p7-field.ts as the concrete type backing
// routing.pool_federation_manifest.
