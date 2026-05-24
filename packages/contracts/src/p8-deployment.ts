/**
 * P8 cross-SDK contracts — types shared across the four deployment variants:
 *
 *   Variant A · BYOK / CMEK            (extends sdk-vault)
 *   Variant B · Sovereign Cloud        (new sdk-sovereign)
 *   Variant C · On-Prem / Air-Gapped   (new sdk-onprem; extends sdk-ai-gateway, sdk-webhook)
 *   Variant D · Active-Active Tier-G+  (extends sdk-pool-router; extends federation schema)
 *
 * Source: docs/v3.1/prd/P8-Deployment-Variants.md §5.A–§5.D and
 *         docs/v3.1/datamodel/P8-Deployment-Variants-DataModel.html §3–§6.
 *
 * Contracts-first per Architecture v3.1 §0 and OC-2 (event registry).
 */

/* ============================================================
 * Variant A · BYOK / CMEK (PRD §5.A · datamodel §3)
 * ============================================================ */

export type ByokProvider = 'aws-kms' | 'gcp-kms' | 'hsm-pkcs11';

export type ByokGrantStatus = 'active' | 'revoking' | 'revoked' | 'degraded';

export interface ByokBindingRef {
  binding_id: string;
  /** One-to-one with tenant. */
  tenant_id: string;
  provider: ByokProvider;
  /** ARN / handle / PKCS#11 alias for the customer-controlled key. */
  customer_kms_key_arn: string;
  /** FK → vault.key (the Tenant Key wrapped under the customer's CMK). */
  tenant_key_id: string;
  grant_status: ByokGrantStatus;
  bound_at: string;
  revoked_at: string | null;
  /** SLO for how fast a revoke must propagate. Default 30s. */
  sla_revoke_propagation_seconds: number;
  /** Optional customer SIEM (Splunk · Elastic · Sumo). */
  siem_forwarder_endpoint: string | null;
}

export type CmkOperation = 'wrap' | 'unwrap' | 'rotate' | 'grant-check';

export interface CmkUseLogRef {
  log_id: string;
  binding_id: string;
  operation: CmkOperation;
  occurred_at: string;
  latency_ms: number;
  provider_response: Record<string, unknown>;
  forwarded_to_siem_at: string | null;
  audit_entry_id: string;
}

export interface CmkRotationRef {
  rotation_id: string;
  binding_id: string;
  started_at: string;
  completed_at: string | null;
  previous_tenant_key_id: string;
  new_tenant_key_id: string;
  /** Should always be false — transparent re-wrap, no leaf re-encryption. */
  leaf_reencryption_needed: boolean;
}

/* ============================================================
 * Variant B · Sovereign Cloud (PRD §5.B · datamodel §4)
 * ============================================================ */

export type SovereignRegime =
  | 'fedramp-high'
  | 'il5'
  | 'pipl'
  | 'eu-sovereign'
  | 'uae-trd';

export type SovereignAttestationState = 'in-progress' | 'attested' | 'expired';

export interface SovereignRegionConfigRef {
  /** e.g. 'us-gov-east-1' · 'cn-bj-1' · 'eu-sovereign-1'. */
  region_id: string;
  regime: SovereignRegime;
  /** In-region MSP (US-cleared · Chinese cloud · EU partner). */
  operator_partner: string;
  /** Pool Router federation manifest treats as terminal when true. */
  terminal_federation: boolean;
  /** Region-specific KMS provider (potentially distinct from default). */
  kms_provider: string;
  activated_at: string;
  attestation_state: SovereignAttestationState;
}

export interface SovereignBundleReleaseRef {
  release_id: string;
  region_id: string;
  /** SemVer of the SDK estate. */
  version: string;
  /** Pointer to the signed container/Helm bundle. */
  bundle_artifact_ref: string;
  /** Detached signature envelope. */
  signature: string;
  shipped_at: string;
  applied_at: string | null;
  rollback_to_release_id: string | null;
}

export interface SovereignAttestationRef {
  attestation_id: string;
  region_id: string;
  regime: SovereignRegime;
  auditor_id: string;
  issued_at: string;
  expires_at: string;
  /** Signed attestation document pointer. */
  artifact_ref: string;
}

export type LeakAlertKind =
  | 'egress-attempt'
  | 'cross-region-route'
  | 'policy-violation';

export type LeakAlertSeverity = 'info' | 'warn' | 'critical';

export interface LeakMonitorAlertRef {
  alert_id: string;
  region_id: string;
  kind: LeakAlertKind;
  severity: LeakAlertSeverity;
  raised_at: string;
  resolved_at: string | null;
  incident_ref: string | null;
}

/* ============================================================
 * Variant C · On-Prem / Air-Gapped (PRD §5.C · datamodel §5)
 * ============================================================ */

export type K8sDistribution = 'vanilla' | 'openshift' | 'rancher' | 'tanzu';

export type AirGapMode = 'strict' | 'diode-in' | 'diode-bidi';

export type OnPremBillingMode = 'internal-report-only' | 'flat-fee' | 'per-incident';

export interface OnPremInstallRef {
  install_id: string;
  customer_id: string;
  cluster_name: string;
  k8s_distribution: K8sDistribution;
  /** SemVer of the platform version currently installed. */
  installed_version: string;
  installed_at: string;
  last_updated_at: string | null;
  air_gap_mode: AirGapMode;
  /** Must be false in strict mode. */
  phone_home: boolean;
  billing_mode: OnPremBillingMode;
}

export interface OnPremBundleApplyRef {
  apply_id: string;
  install_id: string;
  /** SemVer of the bundle being applied. */
  bundle_version: string;
  signature_verified: boolean;
  /** List of executed migrations (per-SDK). */
  migrations_applied: Array<{ sdk: string; filename: string }>;
  started_at: string;
  completed_at: string | null;
  rollback_to_version: string | null;
}

export type LocalLlmBackend = 'ollama' | 'vllm' | 'text-generation-inference';

export type LocalLlmQuantization = 'fp16' | 'int8' | 'int4' | 'awq';

export type LocalLlmStatus = 'ready' | 'loading' | 'disabled';

export interface LocalLlmModelRef {
  /** e.g. 'llama-3.1-70b-instruct'. */
  model_id: string;
  install_id: string;
  backend: LocalLlmBackend;
  /** In-cluster endpoint URL. */
  endpoint_url: string;
  quantization: LocalLlmQuantization;
  status: LocalLlmStatus;
}

export interface OnPremBillingReportRef {
  report_id: string;
  install_id: string;
  period_start: string;
  period_end: string;
  /** Per-SKU rollups. */
  usage_summary: Record<string, { units: number; cost: number }>;
  /** On-cluster PDF/CSV path. */
  artifact_local_path: string;
}

/* ============================================================
 * Variant D · Active-Active Tier-G+ (PRD §5.D · datamodel §6)
 * ============================================================ */

export type ReplicationMode = 'sync' | 'async' | 'single-region';

export type ReplicationRole = 'primary' | 'replica' | 'standby';

export interface ActiveActiveProfileRef {
  profile_id: string;
  /** One-to-one with tenant. */
  tenant_id: string;
  /** Tier-G+ is required for active-active. */
  tier: 'tier-g+';
  /** OLTP write region. */
  home_region: string;
  /** Replicas + failover targets. */
  paired_regions: string[];
  /** Default 5. */
  rpo_target_seconds: number;
  /** Default 60. */
  rto_target_seconds: number;
  /** Sales contract addendum reference. */
  contract_addendum_ref: string;
  activated_at: string;
}

export interface ReplicationStreamRef {
  stream_id: string;
  profile_id: string;
  /** SDK kind — e.g. 'sdk-audit', 'sdk-payment', 'sdk-search', 'sdk-telemetry'. */
  sdk_kind: string;
  mode: ReplicationMode;
  /** Measured replication lag — Tier-G+ SLO compares against rpo_target. */
  lag_seconds_p99: number;
  updated_at: string;
}

export interface FailoverDrillRef {
  drill_id: string;
  profile_id: string;
  from_region: string;
  to_region: string;
  started_at: string;
  resumed_at: string | null;
  rpo_observed_seconds: number;
  rto_observed_seconds: number;
  /** True iff both observed values are within their target. */
  passed: boolean;
  audit_entry_id: string;
  /** True iff a failed drill triggered a Tier-G+ downgrade. */
  tier_downgrade_triggered: boolean;
}
