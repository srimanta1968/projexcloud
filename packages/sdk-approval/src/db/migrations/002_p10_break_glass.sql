-- Migration 002 (P10/E4): audited break-glass emergency access.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- A break-glass grant is an emergency access path: scoped, time-bounded, and
-- approval-gated via the existing approval.request flow. Every use emits a
-- certificate-of-action (stored here + audited). Additive only.

CREATE TABLE IF NOT EXISTS approval.break_glass_grant (
  grant_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  -- The approval.request that gates this grant (NULL only for legacy/no-route).
  request_id           UUID REFERENCES approval.request(request_id) ON DELETE SET NULL,
  requester_persona_id UUID NOT NULL,
  -- What the grant authorizes, e.g. { "resource": "patient.record", "actions": ["read"] }.
  scope                JSONB NOT NULL DEFAULT '{}'::jsonb,
  justification        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','active','expired','revoked')),
  ttl_minutes          INTEGER NOT NULL DEFAULT 60,
  granted_at           TIMESTAMPTZ,
  expires_at           TIMESTAMPTZ,
  -- Latest certificate-of-action JSON emitted on use.
  certificate          JSONB,
  use_count            INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS break_glass_active_idx
  ON approval.break_glass_grant (tenant_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS break_glass_expiry_idx
  ON approval.break_glass_grant (expires_at) WHERE status = 'active';
