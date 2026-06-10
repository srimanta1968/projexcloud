/**
 * P9 / E1 — SDK Capability Manifest types (schema_version "1.0").
 * Source spec: docs/v3.1/prd/P9-SDK-Discoverability-AI-Builder.md §5.1.
 * Doctrine §C: every SDK ships an sdk-capability.json conforming to these
 * types; CI rejects PRs that touch SDK code without an updated manifest.
 */

export type SchemaVersion = '1.0';

export type PoolPlacement =
  | 'admin'
  | 'app'
  | 'evidence'
  | 'global-catalog'
  | 'warehouse'
  | 'vector'
  | 'olap';

export type RetentionClass = 'transient' | 'operational' | 'regulated';

export type ConflictPolicy =
  | 'crdt'
  | 'lww'
  | 'merge'
  | 'event-sourcing'
  | 'human-review';

/**
 * Endpoint classification (P9.2 / Epic B). Drives ingest discovery — an ETL
 * agent can ask the registry for `kind: 'ingest'` endpoints. Defaults to
 * 'query' when absent (backward-compatible).
 */
export type EndpointKind = 'ingest' | 'bulk' | 'query' | 'mutation' | 'webhook';

export interface ManifestEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  description?: string;
  /** ingest | bulk | query | mutation | webhook. Defaults to 'query'. */
  kind?: EndpointKind;
  /** JSON Schema of the request body (P9.2 / Epic B — generated from Zod/TS types). */
  request_schema?: Record<string, unknown>;
  /** JSON Schema of the response body. */
  response_schema?: Record<string, unknown>;
  /** Permission scopes required to call this endpoint, e.g. ["billing:write"]. */
  auth_scopes?: string[];
}

export interface ManifestEvent {
  name: string;
  retention_class: RetentionClass;
  conflict_policy: ConflictPolicy;
  description?: string;
}

export interface ManifestModel {
  schema: string;
  table: string;
  description?: string;
}

export interface ManifestHook {
  name: string;
  description: string;
}

export interface ManifestUiComponent {
  name: string;
  description: string;
}

export interface ManifestProvides {
  endpoints: ManifestEndpoint[];
  events: ManifestEvent[];
  models: ManifestModel[];
  hooks: ManifestHook[];
  ui_components: ManifestUiComponent[];
}

export interface ManifestConsumedEvent {
  name: string;
  from: string;
}

export interface ManifestConsumes {
  events: ManifestConsumedEvent[];
  infra: string[];
  config_keys: string[];
}

export interface ManifestScenario {
  id: string;
  title: string;
  when_to_use: string;
  example_code: string;
  expected_outcome: string;
}

export interface ManifestCompliance {
  regimes: string[];
  notes?: string;
}

export interface ManifestPricingSku {
  sku: string;
  mode: 'flat' | 'metered' | 'subscription';
  unit_description: string;
}

export interface ManifestLinks {
  readme?: string;
  source?: string;
  prd_section?: string;
}

export interface SdkCapabilityManifest {
  name: string;
  version: string;
  schema_version: SchemaVersion;
  summary: string;
  tags: string[];
  provides: ManifestProvides;
  consumes: ManifestConsumes;
  scenarios: ManifestScenario[];
  compliance_posture: ManifestCompliance;
  pool_placement: PoolPlacement;
  pricing_skus: ManifestPricingSku[];
  links: ManifestLinks;
  no_endpoints?: boolean;
}

/* ---------------------------------------------------------------- diff types */

export interface ManifestDiff {
  added: ManifestChange[];
  removed: ManifestChange[];
  changed: ManifestChange[];
  is_breaking: boolean;
}

export type ManifestChangeKind =
  | 'endpoint'
  | 'event'
  | 'model'
  | 'hook'
  | 'scenario'
  | 'pool_placement'
  | 'pricing_sku'
  | 'compliance_regime';

export interface ManifestChange {
  kind: ManifestChangeKind;
  identifier: string;
  before?: unknown;
  after?: unknown;
  is_breaking: boolean;
}
