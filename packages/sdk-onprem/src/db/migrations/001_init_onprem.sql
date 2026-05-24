-- Migration 001: sdk-onprem canonical schema per
-- docs/v3.1/datamodel/P8-Deployment-Variants-DataModel.html §5.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Variant C · On-Prem / Air-Gapped. Single-cluster K8s distribution;
-- quarterly signed bundles; local AI Gateway against Llama/Mistral;
-- federation hooks disabled; webhook outbound restricted in-cluster;
-- meter runs internally for cost tracking but no external invoicing.

CREATE SCHEMA IF NOT EXISTS onprem;

-- ---------------------------------------------------------------------------
-- onprem.install — one row per on-prem cluster.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onprem.install (
  install_id          TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL,
  cluster_name        TEXT NOT NULL,
  k8s_distribution    TEXT NOT NULL CHECK (
    k8s_distribution IN ('vanilla','openshift','rancher','tanzu')
  ),
  installed_version   TEXT NOT NULL,
  installed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_updated_at     TIMESTAMPTZ,
  air_gap_mode        TEXT NOT NULL DEFAULT 'strict' CHECK (
    air_gap_mode IN ('strict','diode-in','diode-bidi')
  ),
  phone_home          BOOLEAN NOT NULL DEFAULT FALSE,
  billing_mode        TEXT NOT NULL DEFAULT 'internal-report-only' CHECK (
    billing_mode IN ('internal-report-only','flat-fee','per-incident')
  ),
  CONSTRAINT onprem_install_strict_no_phone_home CHECK (
    NOT (air_gap_mode = 'strict' AND phone_home = TRUE)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS onprem_install_customer_cluster_uq
  ON onprem.install (customer_id, cluster_name);

-- ---------------------------------------------------------------------------
-- onprem.bundle_apply — quarterly bundle apply history.
-- signature_verified MUST be true; we keep the column so failed installs
-- can record their failure mode.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onprem.bundle_apply (
  apply_id              TEXT PRIMARY KEY,
  install_id            TEXT NOT NULL REFERENCES onprem.install(install_id) ON DELETE CASCADE,
  bundle_version        TEXT NOT NULL,
  signature_verified    BOOLEAN NOT NULL,
  migrations_applied    JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at          TIMESTAMPTZ,
  rollback_to_version   TEXT
);

CREATE INDEX IF NOT EXISTS onprem_bundle_install_idx
  ON onprem.bundle_apply (install_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- onprem.local_llm_model — local-model registry for AI Gateway.
-- One install can host multiple models (Llama for general; Mistral for
-- code; specialty models per vertical).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onprem.local_llm_model (
  model_id        TEXT NOT NULL,
  install_id      TEXT NOT NULL REFERENCES onprem.install(install_id) ON DELETE CASCADE,
  backend         TEXT NOT NULL CHECK (
    backend IN ('ollama','vllm','text-generation-inference')
  ),
  endpoint_url    TEXT NOT NULL,
  quantization    TEXT NOT NULL CHECK (
    quantization IN ('fp16','int8','int4','awq')
  ),
  status          TEXT NOT NULL DEFAULT 'loading' CHECK (
    status IN ('ready','loading','disabled')
  ),
  PRIMARY KEY (install_id, model_id)
);

CREATE INDEX IF NOT EXISTS onprem_local_llm_status_idx
  ON onprem.local_llm_model (install_id, status);

-- ---------------------------------------------------------------------------
-- onprem.billing_report — internal-only periodic usage rollup.
-- artifact_local_path points to a PDF/CSV inside the cluster (no upload).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS onprem.billing_report (
  report_id            TEXT PRIMARY KEY,
  install_id           TEXT NOT NULL REFERENCES onprem.install(install_id) ON DELETE CASCADE,
  period_start         DATE NOT NULL,
  period_end           DATE NOT NULL,
  usage_summary        JSONB NOT NULL DEFAULT '{}'::jsonb,
  artifact_local_path  TEXT NOT NULL,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS onprem_billing_install_idx
  ON onprem.billing_report (install_id, period_start DESC);

-- ---------------------------------------------------------------------------
-- Modifications to existing schemas (per data model §5.2).
-- ADD COLUMN IF NOT EXISTS keeps these idempotent on re-runs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'ai_gateway') THEN
    ALTER TABLE ai_gateway.provider
      ADD COLUMN IF NOT EXISTS local_install_id TEXT;
    CREATE INDEX IF NOT EXISTS ai_gateway_provider_local_install_idx
      ON ai_gateway.provider (local_install_id)
      WHERE local_install_id IS NOT NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'webhook') THEN
    ALTER TABLE webhook.endpoint
      ADD COLUMN IF NOT EXISTS in_cluster_only BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

COMMENT ON SCHEMA onprem IS 'sdk-onprem (P8 Variant C). Install registry + bundle apply history + local LLM registry + internal billing reports.';
