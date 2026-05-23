/**
 * TypeScript model mirroring search.* tables per P4-Operational-Billing-DataModel §8.
 */

export type IndexDefinitionStatus = 'building' | 'active' | 'deprecated' | 'deleting';

export interface IndexDefinitionRecord {
  index_def_id: string;
  tenant_id: string;
  entity_kind: string;
  opensearch_alias: string;
  field_mappings: Record<string, unknown>;
  status: IndexDefinitionStatus;
  created_at: Date;
  updated_at: Date;
}

export interface IndexPartitionRecord {
  partition_id: string;
  index_def_id: string;
  pool_index: number;
  shard: number;
  last_indexed_at: Date | null;
  doc_count: number;
}

export interface SavedQueryRecord {
  query_id: string;
  tenant_id: string;
  persona_id: string;
  name: string;
  dsl: SearchDsl;
  created_at: Date;
}

/**
 * Subset of OpenSearch query DSL we explicitly support. We don't accept
 * arbitrary `script` clauses — those would let callers bypass ABAC.
 */
export interface SearchDsl {
  query?: {
    bool?: {
      must?: unknown[];
      filter?: unknown[];
      should?: unknown[];
      must_not?: unknown[];
    };
    match?: Record<string, unknown>;
    term?: Record<string, unknown>;
    multi_match?: { query: string; fields: string[] };
  };
  size?: number;
  from?: number;
  sort?: unknown[];
}

/* ----------------------------------------------------------- Inputs / DTOs */

export interface RegisterIndexInput {
  tenant_id: string;
  entity_kind: string;
  opensearch_alias?: string;
  field_mappings?: Record<string, unknown>;
}

export interface ExecuteQueryInput {
  tenant_id: string;
  entity_kind: string;
  /** Free-text search; placed inside a multi_match across all index fields. */
  q?: string;
  /** Full DSL — merged with auto-injected ABAC filter. */
  dsl?: SearchDsl;
  size?: number;
  from?: number;
  /**
   * Scope tags the caller asserts they have (from sdk-identity-resolver).
   * Always intersected with the per-tenant index — over-permissive impossible.
   */
  effective_scopes?: string[];
}

export interface ExecuteQueryResult {
  hits: SearchHit[];
  total: number;
  took_ms: number;
  index_used: string;
}

export interface SearchHit {
  _id: string;
  _score: number;
  _source: Record<string, unknown>;
}

export interface SaveQueryInput {
  tenant_id: string;
  persona_id: string;
  name: string;
  dsl: SearchDsl;
}

export interface IndexDocumentInput {
  tenant_id: string;
  entity_kind: string;
  doc_id: string;
  doc: Record<string, unknown>;
  /**
   * Scope tags this document is visible to. Stored on the indexed doc as
   * `_scope_tags` and matched against caller effective_scopes via terms filter.
   */
  scope_tags?: string[];
}
