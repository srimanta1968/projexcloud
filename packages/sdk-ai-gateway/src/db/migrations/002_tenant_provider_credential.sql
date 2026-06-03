-- Migration 002: sdk-ai-gateway · Tenant-BYOK for AI Provider Keys.
-- Adds per-tenant credential envelopes that override the platform-wide
-- ai_gateway.provider credentials. Resolution order in the gateway is
-- tenant-first, platform-fallback. See docs/v3.1/prd/Tenant-BYOK-AI-Keys.md
-- (FR-BYOK-1) and packages/sdk-ai-gateway/src/services/tenantCredentialService.ts.
--
-- Auto-applied by @projexlight/migration-runner against the Admin pool on
-- server boot. Idempotent — re-runs are no-ops.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS ai_gateway;

CREATE TABLE IF NOT EXISTS ai_gateway.tenant_provider_credential (
  binding_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  provider_id          TEXT NOT NULL REFERENCES ai_gateway.provider(provider_id) ON DELETE RESTRICT,
  credential_envelope  BYTEA NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','revoked')),
  model_allowlist      TEXT[],
  last_4               TEXT NOT NULL,
  fallback_on_error    BOOLEAN NOT NULL DEFAULT TRUE,
  bound_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at           TIMESTAMPTZ,
  bound_by             TEXT NOT NULL,
  revoked_by           TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active credential per (tenant, provider). Revoked rows are retained
-- for audit and may coexist with a new active row for the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_provider_credential_active_uniq
  ON ai_gateway.tenant_provider_credential (tenant_id, provider_id)
  WHERE status = 'active';

-- Hot path: gateway resolver looks up active credential by (tenant, provider).
CREATE INDEX IF NOT EXISTS tenant_provider_credential_resolver_idx
  ON ai_gateway.tenant_provider_credential (tenant_id, provider_id, status);

-- Audit / list views scan by tenant.
CREATE INDEX IF NOT EXISTS tenant_provider_credential_tenant_idx
  ON ai_gateway.tenant_provider_credential (tenant_id, bound_at DESC);

-- Row-level security: each tenant sees only its own rows. Operator queries
-- via the admin pool bypass RLS using the postgres role.
ALTER TABLE ai_gateway.tenant_provider_credential ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_provider_credential_tenant_isolation
  ON ai_gateway.tenant_provider_credential;
CREATE POLICY tenant_provider_credential_tenant_isolation
  ON ai_gateway.tenant_provider_credential
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

COMMENT ON TABLE ai_gateway.tenant_provider_credential
  IS 'Per-tenant AI provider credentials. Overrides ai_gateway.provider for the owning tenant; fallthrough to platform credential when no active row exists. PRD §5.1 FR-BYOK-1.';
COMMENT ON COLUMN ai_gateway.tenant_provider_credential.credential_envelope
  IS 'Vault-wrapped raw API key via sdk-secrets wrapProviderCredential; never holds raw material.';
COMMENT ON COLUMN ai_gateway.tenant_provider_credential.last_4
  IS 'Last 4 chars of the raw key for display only; safe to expose in list endpoints.';
COMMENT ON COLUMN ai_gateway.tenant_provider_credential.model_allowlist
  IS 'Optional list of models this credential is allowed to serve. NULL = all models. Out-of-list requests fall through to platform credential.';
COMMENT ON COLUMN ai_gateway.tenant_provider_credential.fallback_on_error
  IS 'When true, runtime auth errors from the provider fall back to the platform credential. When false, the call fails closed (regulated tenants).';
