-- Migration 001: DB-backed, revocable admin ops tokens.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Replaces the single static ADMIN_OPS_TOKEN env var as the source of truth for
-- x-admin-ops-token validation on /admin/* routes. Multiple tokens can be
-- active at once (e.g. a long-lived ops token PLUS a short-lived, revocable QA
-- token), so admin access can be GRANTED and REVOKED with a DB write — no
-- gateway redeploy and no rotation of the shared secret.
--
-- Only the SHA-256 hash of each token is stored; the plaintext bearer secret is
-- returned once at mint time and never persisted. The legacy env ADMIN_OPS_TOKEN
-- remains valid as a break-glass fallback (see adminOpsAuth.ts) so a DB outage
-- or an empty table can never lock operators out.

CREATE SCHEMA IF NOT EXISTS admin;

CREATE TABLE IF NOT EXISTS admin.ops_token (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Human label so operators can tell tokens apart in the UI/audit
  -- (e.g. 'qa-iceberg-tests', 'portal-console', 'ci-smoke').
  label        TEXT NOT NULL,
  -- SHA-256 hex of the bearer secret. UNIQUE so the same secret can't be
  -- registered twice. The raw secret never lands in Postgres.
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','revoked')),
  created_by   TEXT,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = never expires. A token is accepted only while active AND unexpired,
  -- so time-boxed QA grants self-revoke without an explicit call.
  expires_at   TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);

-- Hot path: the validator loads active, unexpired hashes on cache refresh.
CREATE INDEX IF NOT EXISTS ops_token_active_idx
  ON admin.ops_token (status, expires_at)
  WHERE status = 'active';
