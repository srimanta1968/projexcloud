/**
 * P6B cross-SDK contracts — types shared between sdk-knowledge-rag,
 * sdk-parsing, sdk-conversation, sdk-recommendation, sdk-analytics,
 * sdk-lineage, sdk-semantic, and connector-snowflake. Per Architecture
 * v3.1 §0 contracts-first discipline and OC-2 (event registry) doctrine:
 * every shape a P6B SDK emits or consumes lives here, not in a per-SDK
 * type leaf.
 *
 * Source: docs/v3.1/prd/P6B-Knowledge-Semantic.md §5.1–5.8 and
 *         docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §4–§11.
 *
 * Closes Gates G8 (cross-pool lineage projection) and G9
 * (SemanticIntent + SemanticPolicy).
 */

/* ============================================================
 * sdk-knowledge-rag (PRD §5.1 · datamodel §4)
 * ============================================================ */

export type RagSourceKind = 'uploaded' | 'connector' | 'parsed';

export interface RagCorpusRef {
  corpus_id: string;
  tenant_id: string;
  name: string;
  description?: string;
  /** FK into agents.vector_namespace_registry — HARD-isolated per P6A FR-ART-13. */
  vector_namespace: string;
  embedding_model: string;
  embedding_dim: number;
  /** Read policy applied at retrieval. */
  policy_id: string;
  created_at: string;
}

export interface RagDocumentRef {
  document_id: string;
  corpus_id: string;
  source_kind: RagSourceKind;
  /** e.g. media.blob:{blob_id} or external URL. */
  source_ref: string;
  title?: string;
  author?: string;
  /** ISO 639 language code. */
  language?: string;
  indexed_at: string | null;
  reindexed_at: string | null;
  /** Per-document ACL refinement. */
  policy_overrides?: Record<string, unknown>;
}

export interface RagChunkRef {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  /** First 256 chars for explainability surfaces. */
  text_preview: string;
  token_count: number;
  span_start: number;
  span_end: number;
}

export interface RagHit {
  chunk_id: string;
  document_id: string;
  corpus_id: string;
  text_preview: string;
  /** Cosine or provider-native relevance score. */
  score: number;
  /** True if the chunk passed the policy filter for this caller. */
  policy_filtered: false;
  source_ref: string;
  language?: string;
}

export interface RagRetrievalRequest {
  corpus_id: string;
  query_text: string;
  top_k: number;
  /** Caller persona — applied against corpus.policy_id. */
  requestor_persona_id: string;
  /** Optional agent run binding. */
  agent_run_id?: string | null;
  trace_id: string;
}

export interface RagRetrievalResponse {
  retrieval_id: string;
  hits: RagHit[];
  hits_returned: number;
  hits_filtered_out: number;
  latency_ms: number;
}

/* ============================================================
 * sdk-parsing (PRD §5.2 · datamodel §5)
 * ============================================================ */

export type ParseStage =
  | 'ingest'
  | 'ocr'
  | 'classify'
  | 'schema-resolve'
  | 'extract'
  | 'validate'
  | 'review'
  | 'route';

export type ParseStageStatus = 'succeeded' | 'failed' | 'skipped';

export type ParseJobState =
  | 'queued'
  | 'running'
  | 'needs-review'
  | 'completed'
  | 'failed';

export type ParseRequestedMode = 'full-parse' | 're-extract' | 're-validate';

export interface ParseJobRef {
  job_id: string;
  tenant_id: string;
  source_blob_id: string;
  document_kind: string;
  taxonomy_version_id: string;
  state: ParseJobState;
  requested_mode: ParseRequestedMode;
  requested_at: string;
  completed_at: string | null;
  billed_units: number;
}

export interface ProvenanceSpan {
  /** OCR-coordinate or text-span pointer back into the source. */
  page?: number;
  bbox?: [number, number, number, number];
  char_start?: number;
  char_end?: number;
}

export interface ExtractedFieldRef {
  field_id: string;
  job_id: string;
  field_name: string;
  /** 0..1 confidence per field; threshold drives needs_review. */
  confidence: number;
  needs_review: boolean;
  provenance_span: ProvenanceSpan;
  /** Anchor into sdk-lineage for the derivation chain. */
  lineage_node_id: string;
}

export interface ParseRequest {
  tenant_id: string;
  source_blob_id: string;
  document_kind: string;
  mode: ParseRequestedMode;
  trace_id: string;
}

export interface ParseResponse {
  job: ParseJobRef;
}

/* ============================================================
 * sdk-conversation (PRD §5.3 · datamodel §6)
 * ============================================================ */

export type ConversationStatus = 'started' | 'active' | 'handed-off' | 'closed';
export type ConversationAuthorKind = 'user' | 'agent' | 'human-agent' | 'system';
export type ConversationHandoffKind = 'ai' | 'human';

export interface ConversationSessionRef {
  session_id: string;
  tenant_id: string;
  subject_persona_id: string;
  agent_id: string | null;
  status: ConversationStatus;
  started_at: string;
  last_active_at: string;
  /** Per-session HARD-isolated namespace; reuses P6A sandboxed memory. */
  vector_namespace: string;
}

export interface ConversationTurn {
  turn_id: string;
  session_id: string;
  seq: number;
  author_kind: ConversationAuthorKind;
  author_id: string;
  tokens: number;
  model_used?: string | null;
  /** Cross-link into sdk-knowledge-rag retrieval that grounded this turn. */
  rag_retrieval_id?: string | null;
  occurred_at: string;
}

export interface ConversationHandoff {
  handoff_id: string;
  session_id: string;
  from_kind: ConversationHandoffKind;
  to_persona_id: string;
  reason: string;
  transferred_at: string;
  resumed_at: string | null;
}

export interface SendMessageRequest {
  session_id: string;
  author_kind: ConversationAuthorKind;
  author_id: string;
  /** Plaintext; the SDK envelope-encrypts before storage. */
  message_text: string;
  stream?: boolean;
  trace_id: string;
}

/* ============================================================
 * sdk-recommendation (PRD §5.4 · datamodel §7)
 * ============================================================ */

export type RecommendationPurpose =
  | 'similar-x'
  | 'next-best-action'
  | 'churn-risk'
  | 'upsell';

export type RecommendationModelStatus = 'training' | 'active' | 'retired';

export type RecommendationOutcome = 'accepted' | 'dismissed' | 'ignored';

export interface RecommendationModelRef {
  model_id: string;
  tenant_id: string;
  purpose: RecommendationPurpose;
  algorithm: string;
  /** Per-tenant artifact namespace — vector-isolated. */
  vector_namespace: string;
  trained_at: string | null;
  feature_flag_id?: string | null;
  status: RecommendationModelStatus;
}

export interface RecommendationSuggestion {
  suggestion_id: string;
  model_id: string;
  subject_persona_id: string;
  suggestion_kind: string;
  payload: Record<string, unknown>;
  /** 0..1; higher = stronger recommendation. */
  score: number;
  trace_id: string;
  generated_at: string;
}

export interface RecommendationFeedback {
  feedback_id: string;
  suggestion_id: string;
  outcome: RecommendationOutcome;
  captured_at: string;
}

/* ============================================================
 * sdk-analytics (PRD §5.5 · datamodel §8) — Iceberg lakehouse ramp
 * ============================================================ */

export type AnalyticsTargetKind = 'clickhouse' | 'iceberg';
export type AnalyticsGrain = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface RollupSpec {
  spec_id?: string;
  /** Null = platform-default spec. */
  tenant_id: string | null;
  name: string;
  grain: AnalyticsGrain;
  dimensions: string[];
  source_event_types: string[];
  target_kind: AnalyticsTargetKind;
  active: boolean;
}

export interface RollupResult {
  spec_id: string;
  rows: Array<Record<string, unknown>>;
  row_count: number;
  query_ms: number;
  /** Sanctioned cross-pool reason if applicable (lineage/analytics). */
  cross_pool_reason?: 'analytics' | null;
}

export interface AnalyticsQuery {
  spec_id: string;
  /** ISO-8601 inclusive lower bound. */
  from: string;
  to: string;
  /** Optional dimension filters. */
  filters?: Record<string, string | number | boolean>;
  /** When true, force read against Iceberg lakehouse. */
  cold?: boolean;
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
  row_count: number;
  source: AnalyticsTargetKind;
  bytes_scanned?: number;
  query_ms: number;
}

export interface IcebergTableRef {
  /** catalog.namespace.table — e.g. warehouse.usage_daily. */
  ref: string;
  partition_strategy?: Record<string, unknown>;
}

export interface ExtractSpec {
  tenant_id: string | null;
  iceberg_table_ref: string;
  partition_strategy: Record<string, unknown>;
  /** Consent purpose required when extract carries PII. */
  consent_gate_purpose?: string | null;
}

/* ============================================================
 * sdk-lineage (PRD §5.6 · datamodel §9) — G8 closer
 * ============================================================ */

export type LineageNodeKind =
  | 'field'
  | 'record'
  | 'blob'
  | 'agent-output'
  | 'recommendation'
  | 'model';

export type LineageEdgeKind =
  | 'extracted_from'
  | 'derived_from'
  | 'merged_from'
  | 'scored_by'
  | 'translated_by';

export type LineageProjectionState = 'pending' | 'projected' | 'failed';

export interface LineageNodeRef {
  node_id: string;
  pool_index: string;
  kind: LineageNodeKind;
  ref_kind: string;
  ref_id: string;
  tenant_id: string;
  created_at: string;
}

export interface LineageEdgeRef {
  edge_id: string;
  from_node_id: string;
  to_node_id: string;
  edge_kind: LineageEdgeKind;
  producer_sdk: string;
  producer_event_id?: string | null;
  trace_id: string;
  occurred_at: string;
}

export interface LineageEmitInput {
  from: { ref_kind: string; ref_id: string; kind: LineageNodeKind; tenant_id: string };
  to: { ref_kind: string; ref_id: string; kind: LineageNodeKind; tenant_id: string };
  edge_kind: LineageEdgeKind;
  producer_sdk: string;
  producer_event_id?: string | null;
  trace_id: string;
}

export interface LineageChainStep {
  edge: LineageEdgeRef;
  from_node: LineageNodeRef;
  to_node: LineageNodeRef;
  /** True when the step came from the cross-pool Iceberg projection. */
  cross_pool: boolean;
}

export interface LineageChain {
  /** The record being traced. */
  ref_kind: string;
  ref_id: string;
  steps: LineageChainStep[];
  /** In-pool segment latency. */
  in_pool_ms: number;
  /** Cross-pool segment latency (Iceberg). */
  cross_pool_ms: number;
}

/* ============================================================
 * sdk-semantic (PRD §5.7 · datamodel §10) — G9 closer · 6 types
 * ============================================================ */

export type OntologyStatus = 'draft' | 'active' | 'deprecated' | 'retired';
export type SemanticRelationCardinality = '1:1' | '1:N' | 'N:N';
export type PlanStatus =
  | 'proposed'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'abandoned';
export type SemanticPolicyStatus = 'draft' | 'active' | 'deprecated';
export type SemanticBridgeAccessMode = 'read-only' | 'read-write';

/** Type 1 of 6 — SemanticObject. */
export interface SemanticObjectTypeRef {
  object_type_id: string;
  ontology_id: string;
  name: string;
  /** Typed attribute schema drawn from MDM + persona extensions. */
  attribute_schema: Record<string, unknown>;
  /** Source SDK + table — e.g. persona.persona_ext:patient_chart. */
  backed_by: string;
}

/** Type 2 of 6 — SemanticRelation. */
export interface SemanticRelationTypeRef {
  relation_type_id: string;
  ontology_id: string;
  /** e.g. treats · owns · funds · refers · derives_from. */
  name: string;
  from_object_type_id: string;
  to_object_type_id: string;
  cardinality: SemanticRelationCardinality;
  /** If implemented atop sdk-rebac, the underlying ReBAC edge kind. */
  rebac_kind_mapping?: string | null;
}

/** Type 3 of 6 — CapabilityGraph. */
export interface CapabilityGraphEdgeRef {
  edge_id: string;
  object_type_id: string;
  /** Valid SDK operation expressed as a meter SKU. */
  tool_sku: string;
  /** Required relation between caller and subject (e.g. doctor → patient). */
  requires_relation?: string | null;
  pre_conditions: Record<string, unknown>;
  post_conditions: Record<string, unknown>;
}

/** Type 4 of 6 — DomainOntology bundle ref. */
export interface OntologyRef {
  ontology_id: string;
  name: string;
  /** SemVer. */
  version: string;
  status: OntologyStatus;
  parent_ontology_id?: string | null;
  /** Pointer to @projexlight/contracts version or Global Catalog blob. */
  bundle_ref: string;
}

/** Bundle payload for ontology registration. */
export interface DomainOntologyBundle {
  name: string;
  version: string;
  parent_ontology?: { name: string; version: string } | null;
  object_types: Array<Omit<SemanticObjectTypeRef, 'object_type_id' | 'ontology_id'>>;
  relation_types: Array<
    Omit<SemanticRelationTypeRef, 'relation_type_id' | 'ontology_id' | 'from_object_type_id' | 'to_object_type_id'> & {
      from_object_type_name: string;
      to_object_type_name: string;
    }
  >;
  capability_graph: Array<
    Omit<CapabilityGraphEdgeRef, 'edge_id' | 'object_type_id' | 'requires_relation'> & {
      object_type_name: string;
      requires_relation_name?: string | null;
    }
  >;
}

/** Subject reference inside a SemanticIntent. */
export interface SemanticIntentSubject {
  /** Object type name (e.g. Patient). */
  type: string;
  /** Specific instance — must resolve under the active ontology + tenant. */
  id: string;
}

/** Type 5 of 6 — SemanticIntent. */
export interface SemanticIntent {
  intent_id?: string;
  tenant_id: string;
  ontology_id: string;
  /** e.g. schedule_follow_up_visit. */
  goal: string;
  subject: SemanticIntentSubject;
  parameters: Record<string, unknown>;
  trace_id: string;
}

/** Single executable step in a Plan. */
export interface PlanStep {
  step_index: number;
  tool_sku: string;
  args: Record<string, unknown>;
  /** capability_graph_edge.edge_id used to validate this step. */
  capability_edge_id: string;
}

export interface Plan {
  plan_id: string;
  intent_id: string;
  subject_id: string;
  steps: PlanStep[];
  generated_by_agent_run_id?: string | null;
  generated_at: string;
  status: PlanStatus;
}

/** Type 6 of 6 — SemanticPolicy. */
export interface SemanticPolicyRef {
  policy_id: string;
  tenant_id: string | null;
  ontology_id: string;
  name: string;
  description?: string;
  /** Authored Identity Query Language source. */
  iql_source: string;
  /** Compiled ABAC term (opaque to clients). */
  compiled_abac: string;
  /** Compiled ReBAC edge requirements. */
  compiled_rebac: Record<string, unknown>;
  status: SemanticPolicyStatus;
}

export interface SemanticPolicyDecision {
  policy_id: string;
  decision: 'allow' | 'deny';
  /** Human-readable reason; logged to sdk-audit. */
  reason: string;
  /** ms — must be ≤ 5ms p99 per PRD §6. */
  latency_ms: number;
  /** trace_id for the originating request. */
  trace_id: string;
}

export interface CrossDomainBridgeRef {
  bridge_id: string;
  from_object_type_id: string;
  to_object_type_id: string;
  access_mode: SemanticBridgeAccessMode;
  /** When true, callers must present a cross-tenant consent receipt. */
  requires_cross_tenant_consent: boolean;
}

/* ============================================================
 * connector-snowflake (PRD §5.8 · datamodel §11)
 * ============================================================ */

export type SnowflakeInstallStatus =
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'error';

export type SnowflakeBindingDirection = 'snow_to_ice' | 'ice_to_snow' | 'bidir';

export type SnowflakeSyncStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface SnowflakeInstallRef {
  install_id: string;
  tenant_id: string;
  account_url: string;
  status: SnowflakeInstallStatus;
  last_refreshed_at: string;
}

export interface SnowflakeTableBindingRef {
  binding_id: string;
  install_id: string;
  snowflake_table: string;
  iceberg_table_ref: string;
  direction: SnowflakeBindingDirection;
  /** e.g. 'lww' · 'last-write-wins' · 'append-only'. */
  conflict_policy: string;
  last_synced_at: string | null;
}

export interface SnowflakeSyncRun {
  run_id: string;
  binding_id: string;
  started_at: string;
  completed_at: string | null;
  rows_pushed: number;
  rows_pulled: number;
  status: SnowflakeSyncStatus;
}

export interface SnowflakeQueryRequest {
  install_id: string;
  /** SoQL or SQL — gated by capability token. */
  sql: string;
  /** Required: agent run binding. */
  agent_run_id: string;
  capability_token_id: string;
  trace_id: string;
}

export interface SnowflakeQueryResult {
  query_id: string;
  rows: Array<Record<string, unknown>>;
  bytes_scanned: number;
  provider_cost: number;
  billed_cost: number;
  latency_ms: number;
}
