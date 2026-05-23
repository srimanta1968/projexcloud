-- Migration 001: sdk-api-keys canonical schema per P2-Identity-Access-DataModel §11.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Pool placement: Admin (per PRD §5.6). Each key bound to a synthetic
-- persona so audit + ReBAC behave consistently.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS api_keys;

CREATE TABLE IF NOT EXISTS api_keys.key (
  key_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  prefix              TEXT NOT NULL,
  key_hash            BYTEA NOT NULL,
  hash_alg            TEXT NOT NULL DEFAULT 'pbkdf2-sha256-310000'
                        CHECK (hash_alg IN ('pbkdf2-sha256-310000','argon2id')),
  synthetic_persona_id UUID NOT NULL,
  scopes              TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  rate_limit_rpm      INTEGER,
  expires_at          TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','rotating','revoked','expired')),
  last_used_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_from_key_id UUID,
  revoked_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS apikey_prefix_idx  ON api_keys.key (prefix);
CREATE INDEX IF NOT EXISTS apikey_tenant_idx         ON api_keys.key (tenant_id, status);
CREATE INDEX IF NOT EXISTS apikey_active_idx         ON api_keys.key (tenant_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS apikey_expiring_idx       ON api_keys.key (expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
