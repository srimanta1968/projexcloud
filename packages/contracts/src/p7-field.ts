/**
 * P7 cross-SDK contracts — types shared between sdk-storm, sdk-dispatch,
 * sdk-assignment, sdk-lead-scoring, sdk-evidence, sdk-diagnostic-telemetry,
 * pool-federation-runtime, sdk-analytics (Iceberg federation extension),
 * sdk-meter (hard-cap mode), hdk-measure, hdk-watermark.
 *
 * Source: docs/v3.1/prd/P7-Field-Hyperscale.md §5.1–5.9 and
 *         docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §4–§13.
 *
 * Closes Gates G10 (pool federation runtime) and G11 (Iceberg lakehouse
 * full federation). Activates meter hard-cap (DENY) mode.
 *
 * Contracts-first per Architecture v3.1 §0 and OC-2 (event registry).
 */

/* ============================================================
 * sdk-storm (PRD §5.1 · datamodel §4)
 * ============================================================ */

export type StormKind =
  | 'hurricane'
  | 'tornado'
  | 'hail'
  | 'flood'
  | 'wildfire'
  | 'winter';

export type StormProvider = 'noaa' | 'dtn' | 'weather-underground';

export interface StormEventRef {
  event_id: string;
  name: string;
  kind: StormKind;
  provider: StormProvider;
  provider_event_id: string;
  /** GeoJSON Polygon (4326) covering the storm footprint. */
  geom: unknown;
  started_at: string;
  ended_at: string | null;
  /** Provider-native severity scale (e.g. Cat 1–5 for hurricane). */
  severity: string;
}

export interface StormIntensityCellRef {
  cell_id: string;
  event_id: string;
  cell_geom: unknown;
  wind_mph: number | null;
  hail_in: number | null;
  rainfall_in: number | null;
  gust_mph: number | null;
  captured_at: string;
}

/* ============================================================
 * sdk-dispatch (PRD §5.2 · datamodel §5)
 * ============================================================ */

export type DispatchTaskStatus =
  | 'queued'
  | 'assigned'
  | 'in-progress'
  | 'completed'
  | 'cancelled';

export type DispatchQueueStatus = 'active' | 'paused' | 'archived';

export interface DispatchQueueRef {
  queue_id: string;
  tenant_id: string;
  name: string;
  /** Priority / territory / skill rules. */
  policy: Record<string, unknown>;
  status: DispatchQueueStatus;
}

export interface DispatchTaskRef {
  task_id: string;
  queue_id: string;
  encounter_id: string;
  address_id: string;
  priority: number;
  status: DispatchTaskStatus;
  scheduled_for: string | null;
}

export interface DispatchRouteRef {
  route_id: string;
  /** Dispatcher persona owning this route. */
  persona_id: string;
  /** Ordered list of task_ids. */
  stops: string[];
  optimized_at: string;
  total_drive_mins: number;
}

/* ============================================================
 * sdk-assignment (PRD §5.3 · datamodel §6)
 * ============================================================ */

export type AssignmentStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'completed';

export interface AssignmentRef {
  assignment_id: string;
  task_id: string;
  persona_id: string;
  assigned_at: string;
  accepted_at: string | null;
  status: AssignmentStatus;
}

export interface TerritoryRef {
  territory_id: string;
  tenant_id: string;
  name: string;
  /** GeoJSON Polygon (4326). */
  geom: unknown;
  primary_persona_ids: string[];
  backup_persona_ids: string[];
}

export interface WorkloadRef {
  persona_id: string;
  open_tasks: number;
  capacity_per_day: number;
  skills: string[];
  available_from: string | null;
  available_to: string | null;
}

/* ============================================================
 * sdk-lead-scoring (PRD §5.4 · datamodel §7)
 * ============================================================ */

export type LeadScoringModelStatus = 'training' | 'active' | 'retired';

export interface LeadScoringModelRef {
  model_id: string;
  tenant_id: string;
  vertical: string;
  trained_at: string | null;
  /** Per-vertical feature schema (proximity weight, expertise weight, …). */
  feature_set: Record<string, unknown>;
  status: LeadScoringModelStatus;
}

export interface LeadScoreSubscores {
  proximity?: number;
  expertise?: number;
  intent?: number;
  storm_impact?: number;
}

export interface LeadScoreRef {
  score_id: string;
  model_id: string;
  contact_id: string;
  score: number;
  /** Per-factor sub-scores; sums weighted by feature_weight. */
  components: LeadScoreSubscores;
  computed_at: string;
  trace_id: string;
}

export interface LeadScoringFeatureWeightRef {
  weight_id: string;
  model_id: string;
  feature: string;
  weight: number;
  last_tuned_at: string | null;
}

/* ============================================================
 * sdk-evidence (PRD §5.5 · datamodel §8) — Chain-of-custody linchpin
 * ============================================================ */

export type EvidenceCaptureStatus = 'active' | 'sealed' | 'shredded';

export type EvidenceVariantKind =
  | 'edited'
  | 'watermarked'
  | 'annotated'
  | 'redacted';

export type ChainOfCustodyAction =
  | 'captured'
  | 'transferred'
  | 'edited'
  | 'watermarked'
  | 'exported'
  | 'accessed';

export type LegalExportJurisdiction =
  | 'us-court'
  | 'eu-gdpr'
  | 'india-it-act'
  | string;

export interface EvidenceCaptureRef {
  capture_id: string;
  tenant_id: string;
  /** Required FK; sealed encounters block new captures (FR-EVD-5). */
  encounter_id: string;
  capturer_persona_id: string;
  device_uuid: string;
  device_attestation_id: string;
  /** FK → media.blob; raw is never overwritten (FR-EVD-2). */
  raw_blob_id: string;
  /** Device clock + server-time delta. */
  captured_at: string;
  lat: number | null;
  lng: number | null;
  altitude: number | null;
  /** Motion-sensor signature at capture. */
  imu_signature?: string | null;
  consent_ref: string;
  retention_class: string;
  retention_expires_at: string | null;
  status: EvidenceCaptureStatus;
}

export interface EvidenceVariantRef {
  variant_id: string;
  capture_id: string;
  kind: EvidenceVariantKind;
  variant_blob_id: string;
  /** From hdk-image-editor / hdk-watermark. */
  edit_log: Record<string, unknown>;
  created_by_persona_id: string;
  created_at: string;
}

export interface ChainOfCustodyEntry {
  entry_id: string;
  capture_id: string;
  /** Append-only per capture; gap or order violation = chain break. */
  seq: number;
  action: ChainOfCustodyAction;
  actor_persona_id: string;
  /** SHA-256 of the relevant blob (raw or variant). */
  blob_checksum: string;
  /** Hash-chain pointers; entry_hash = sha256(prev_hash || blob_checksum || action || seq). */
  prev_hash: string;
  entry_hash: string;
  /** Cross-link into sdk-audit for tamper-evidence correlation. */
  audit_entry_id: string;
  occurred_at: string;
}

export interface EvidenceLegalExportRef {
  export_id: string;
  requestor_persona_id: string;
  jurisdiction: LegalExportJurisdiction;
  capture_ids: string[];
  /** S3 key for the signed PDF + JSONL + media bundle. */
  artifact_s3_key: string;
  /** Detached signature envelope. */
  signature_envelope: string;
  /** Per-capture verification results at export time. */
  chain_verifications: Record<string, unknown>;
  generated_at: string;
}

/* ============================================================
 * sdk-diagnostic-telemetry (PRD §5.6 · datamodel §9)
 * ============================================================ */

export interface DiagnosticCrashRef {
  crash_id: string;
  device_uuid: string;
  person_id: string | null;
  app_version: string;
  os_version: string;
  /** Encrypted stack-frame envelope. */
  stack_envelope: string;
  occurred_at: string;
}

export interface DiagnosticHealthSnapshotRef {
  snapshot_id: string;
  device_uuid: string;
  /** Per-permission grant state. */
  permissions: Record<string, boolean>;
  battery_pct: number | null;
  wifi_state: string | null;
  sensor_state: Record<string, unknown>;
  captured_at: string;
}

export interface DiagnosticSessionReplayEventRef {
  event_id: string;
  device_uuid: string;
  /** Privacy-sanitized event kind; no PII. */
  sanitized_event_kind: string;
  payload: Record<string, unknown>;
  occurred_at: string;
}

/* ============================================================
 * Pool Federation Runtime (PRD §5.7 · datamodel §10) — G10 closer
 * ============================================================ */

export type FederationCapacityClass = 'standard' | 'premium' | 'tier-g';

export type FederationQueryClass =
  | 'resolver'
  | 'dsar'
  | 'analytics'
  | 'lineage';

export type FederationFailoverTrigger =
  | 'chaos-drill'
  | 'production-failover'
  | 'operator-initiated';

/**
 * Concrete shape of a row in routing.pool_federation_manifest (P1 hook).
 * The runtime registry in federation.federation references one of these
 * via manifest_id. This is the source of truth for tenant → pools.
 *
 * Replaces the v0 stub previously exported from contracts/src/stubs.ts.
 */
export interface PoolFederationManifest {
  manifest_id: string;
  tenant_id: string;
  pool_indexes: string[];
  query_class: FederationQueryClass;
  created_at: string;
}

export interface FederationRef {
  federation_id: string;
  /**
   * Logical FK to routing.pool_federation_manifest.manifest_id (P1 hook).
   * The P1 manifest is the source-of-truth tenant→pool mapping; this
   * runtime row layers region, capacity_class, and a stable human-readable
   * name on top. Null only for federations created before the runtime
   * started referencing the manifest.
   */
  manifest_id: string | null;
  region: string;
  name: string;
  description?: string | null;
  /** Superset of pool indexes enrolled; per-query_class subsets live in FederationRouteRef. */
  pool_indexes: string[];
  capacity_class: FederationCapacityClass;
  activated_at: string;
}

export interface FederationRouteRef {
  route_id: string;
  federation_id: string;
  query_class: FederationQueryClass;
  /** Pool indexes selected for this query class. */
  target_pool_indexes: string[];
  /** Per-pool sub-query plan + merge strategy. */
  execution_plan: Record<string, unknown>;
  created_at: string;
  last_used_at: string | null;
}

export interface FederationFailoverEventRef {
  event_id: string;
  federation_id: string;
  from_region: string;
  to_region: string;
  trigger: FederationFailoverTrigger;
  /** Recovery Point Objective observed, in seconds. */
  rpo_observed: number;
  /** Recovery Time Objective observed, in seconds. */
  rto_observed: number;
  occurred_at: string;
}

/* ============================================================
 * Iceberg Lakehouse Federation (PRD §5.8 · datamodel §11) — G11 closer
 * ============================================================ */

export type IcebergCatalogBackend = 'glue' | 'nessie' | 'hive';

export type IcebergCatalogStatus = 'active' | 'degraded' | 'retired';

export interface IcebergCatalogRef {
  catalog_id: string;
  region: string;
  backend: IcebergCatalogBackend;
  root_url: string;
  capacity_tier: string;
  status: IcebergCatalogStatus;
}

export interface IcebergTableBindingRef {
  binding_id: string;
  catalog_id: string;
  /** catalog.namespace.table reference. */
  table_ref: string;
  /** Source ClickHouse table being mirrored to Iceberg. */
  source_clickhouse_table: string | null;
  /** Partition strategy: e.g. {"by": ["region","tenant","time"], "z_order": [...]}. */
  partition_strategy: Record<string, unknown>;
  z_order_cols: string[];
  last_compacted_at: string | null;
}

export interface LakehouseQueryLogRef {
  query_id: string;
  tenant_id: string;
  agent_run_id: string | null;
  sql_text: string;
  bytes_scanned: number;
  /** Provider-billed cost in USD (or equivalent). */
  cost: number;
  trace_id: string;
  occurred_at: string;
}

/* ============================================================
 * sdk-meter hard-cap mode (PRD §12 · datamodel §12)
 * ============================================================ */

export type MeterMode = 'emit-only' | 'soft-cap' | 'hard-cap';

export interface QuotaDenialRef {
  denial_id: string;
  tenant_id: string;
  sku: string;
  policy_id: string;
  denied_at: string;
  /** For triage — how many requests this tenant made in the prior 24h. */
  request_count_24h: number;
  /** When set, ops has lifted the cap until this time. */
  operator_override_until: string | null;
}

/* ============================================================
 * HDK measure + watermark (PRD §5.9 · datamodel §13)
 * ============================================================ */

export type MeasurementKind = 'area' | 'distance' | 'volume';

export type MeasurementAccuracyClass = 'high' | 'medium' | 'low';

export interface MeasurementRef {
  measurement_id: string;
  /** FK → evidence.capture; the photo this measurement was taken against. */
  capture_id: string;
  kind: MeasurementKind;
  value: number;
  /** e.g. m², m, m³, ft, in. */
  unit: string;
  accuracy_class: MeasurementAccuracyClass;
  device_uuid: string;
  captured_at: string;
}

export type WatermarkScheme = 'visible' | 'invisible' | 'cryptographic';

export interface WatermarkApplicationRef {
  application_id: string;
  /** FK → evidence.variant; one watermark application per variant row. */
  variant_id: string;
  scheme: WatermarkScheme;
  /** Encrypted payload envelope (key id + bytes). */
  payload_envelope: string;
  applied_at: string;
}
