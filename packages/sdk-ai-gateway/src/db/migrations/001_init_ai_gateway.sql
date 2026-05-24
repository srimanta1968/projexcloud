-- Migration 001: sdk-ai-gateway canonical schema per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §4.
-- Auto-applied by @projexlight/migration-runner against the Admin pool.
--
-- Tables: ai_gateway.provider (with credential_envelope vaulted),
--         ai_gateway.route_rule (per-tenant routing),
--         ai_gateway.completion (per-call record + langfuse + trace cross-ref),
--         ai_gateway.pii_redaction_rule.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ai_gateway;

CREATE TABLE IF NOT EXISTS ai_gateway.provider (
  provider_id            TEXT PRIMARY KEY,
  display_name           TEXT NOT NULL,
  base_url               TEXT NOT NULL,
  credential_envelope    BYTEA NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','degraded','disabled')),
  circuit_state          TEXT NOT NULL DEFAULT 'closed'
                           CHECK (circuit_state IN ('closed','half-open','open')),
  failure_streak         INTEGER NOT NULL DEFAULT 0,
  last_failure_at        TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_status_idx ON ai_gateway.provider (status, circuit_state);

CREATE TABLE IF NOT EXISTS ai_gateway.route_rule (
  rule_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  predicate   JSONB NOT NULL,
  provider_id TEXT NOT NULL REFERENCES ai_gateway.provider(provider_id) ON DELETE RESTRICT,
  model       TEXT NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 100,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS route_rule_tenant_idx ON ai_gateway.route_rule (tenant_id, active, priority);
CREATE INDEX IF NOT EXISTS route_rule_provider_idx ON ai_gateway.route_rule (provider_id);

CREATE TABLE IF NOT EXISTS ai_gateway.completion (
  completion_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID,
  persona_id             UUID,
  agent_run_id           UUID,
  provider_id            TEXT NOT NULL REFERENCES ai_gateway.provider(provider_id) ON DELETE RESTRICT,
  model                  TEXT NOT NULL,
  tokens_in              INTEGER NOT NULL DEFAULT 0,
  tokens_out             INTEGER NOT NULL DEFAULT 0,
  provider_cost          NUMERIC(18,8) NOT NULL DEFAULT 0,
  billed_cost            NUMERIC(18,8) NOT NULL DEFAULT 0,
  pii_redaction_applied  BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms             INTEGER NOT NULL DEFAULT 0,
  started_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  langfuse_trace_id      TEXT,
  trace_id               TEXT,
  finish_reason          TEXT
                           CHECK (finish_reason IN ('stop','length','tool_call','content_filter','cancelled'))
);

CREATE INDEX IF NOT EXISTS completion_tenant_idx       ON ai_gateway.completion (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS completion_provider_idx     ON ai_gateway.completion (provider_id, started_at DESC);
CREATE INDEX IF NOT EXISTS completion_trace_idx        ON ai_gateway.completion (trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS completion_agent_run_idx    ON ai_gateway.completion (agent_run_id) WHERE agent_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_gateway.pii_redaction_rule (
  rule_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID,
  pattern      TEXT NOT NULL,
  replacement  TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pii_rule_lookup_idx
  ON ai_gateway.pii_redaction_rule (COALESCE(tenant_id::text, ''), active);

COMMENT ON SCHEMA ai_gateway IS 'sdk-ai-gateway canonical schema · P6A §5.1.';
COMMENT ON COLUMN ai_gateway.provider.credential_envelope
  IS 'Vault-wrapped API key envelope; never holds raw key material.';
COMMENT ON COLUMN ai_gateway.completion.langfuse_trace_id
  IS 'External Langfuse trace id; composes with trace_id (OTel) for cross-system viewer.';
