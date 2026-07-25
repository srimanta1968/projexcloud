-- Migration 001: sdk-config canonical schema — the Unified Multi-Scope
-- Configuration & Secrets Plane (EP-341). Generalizes the proven
-- ai_gateway.tenant_provider_credential pattern into ONE shared store whose
-- rows resolve at PLATFORM -> TENANT -> APP -> APP-USER scope (most specific
-- wins, falling back up the chain). Auto-applied by @projexlight/migration-runner
-- (P1 doctrine); additive + idempotent (MUST-50).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS config;

-- ---------------------------------------------------------------------------
-- config.config_value — one row per (scope, scope_id, key). A non-secret value
-- lives inline in `value` (jsonb); a secret value is stored via sdk-secrets
-- envelope encryption and only its pointer is kept here in `secret_ref` (the
-- plaintext NEVER touches this table). resolveConfig() reads the most-specific
-- active row for a key given a request context.
--
--   scope     — the precedence tier this value applies at.
--   scope_id  — the id the value is scoped to: '' for platform (global default),
--               tenant_id for tenant, app_id for app, app_user_id for app_user.
--   key       — dotted config key, e.g. 'llm.provider', 'aws.s3', 'payment.collect'.
--   value     — non-secret JSON payload (null when the value is a secret).
--   secret_ref— sdk-secrets envelope pointer for secret values (null otherwise).
--   status    — 'active' | 'revoked' (revoke is a soft delete that stops
--               resolution without losing the audit trail).
--   set_by    — persona/operator id that last set the value (audit).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config.config_value (
  config_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL
                CHECK (scope IN ('platform','tenant','app','app_user')),
  scope_id    TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value       JSONB,
  secret_ref  TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','revoked')),
  set_by      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One canonical row per (scope, scope_id, key); setConfig upserts on it.
  UNIQUE (scope, scope_id, key)
);

-- Hot-path resolution lookup: resolveConfig reads active rows for a key across
-- the scope chain for a given context.
CREATE INDEX IF NOT EXISTS config_value_resolve_idx
  ON config.config_value (key, status, scope, scope_id);
CREATE INDEX IF NOT EXISTS config_value_scope_idx
  ON config.config_value (scope, scope_id, status);

CREATE OR REPLACE FUNCTION config.config_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS config_value_touch ON config.config_value;
CREATE TRIGGER config_value_touch BEFORE UPDATE ON config.config_value
  FOR EACH ROW EXECUTE FUNCTION config.config_touch_updated_at();

COMMENT ON TABLE config.config_value IS
  'Unified multi-scope config/secrets store (EP-341). Resolves platform->tenant->app->app_user; secret values kept as sdk-secrets envelope pointers in secret_ref, never inline.';
