-- Migration 001: sdk-tenant-lifecycle (P4 §5.9) per P4 DataModel §12.
-- FR-TLC-1..7. Auto-applied by @projexlight/migration-runner.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS tenant_lifecycle;

-- One row per tenant. The FSM is enforced in the service layer; the CHECK
-- guards against direct SQL writes inserting invalid states.
CREATE TABLE IF NOT EXISTS tenant_lifecycle.state (
  tenant_id                   UUID PRIMARY KEY,
  current_state               TEXT NOT NULL DEFAULT 'active'
                                CHECK (current_state IN ('active','suspended','offboarding','offboarded','sandbox')),
  suspended_reason            TEXT,
  sandbox_parent_tenant_id    UUID,
  offboard_deadline_at        TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                  TEXT
);

CREATE INDEX IF NOT EXISTS tlc_state_current_idx
  ON tenant_lifecycle.state (current_state);
CREATE INDEX IF NOT EXISTS tlc_state_deadline_idx
  ON tenant_lifecycle.state (offboard_deadline_at)
  WHERE current_state = 'offboarding';

-- Transition log. Append-only; reads are by tenant_id.
CREATE TABLE IF NOT EXISTS tenant_lifecycle.event (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  from_state   TEXT,
  to_state     TEXT NOT NULL,
  reason       TEXT,
  actor_id     TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS tlc_event_tenant_idx
  ON tenant_lifecycle.event (tenant_id, occurred_at DESC);

-- Sandbox sub-pool config. sandbox_tenant_id is the child tenant uuid.
CREATE TABLE IF NOT EXISTS tenant_lifecycle.sandbox (
  sandbox_tenant_id    UUID PRIMARY KEY,
  parent_tenant_id     UUID NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at           TIMESTAMPTZ,
  sanitization_policy  TEXT NOT NULL DEFAULT 'default-mask-pii'
);

CREATE INDEX IF NOT EXISTS tlc_sandbox_parent_idx
  ON tenant_lifecycle.sandbox (parent_tenant_id);

-- RLS: tenants only see their own row. The session must SET app.tenant_id
-- to the caller's tenant_id; api-gateway middleware does this on every
-- request. Admin operators bypass via service-role bypass policy.
ALTER TABLE tenant_lifecycle.state ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_lifecycle.event ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tlc_state_tenant_isolation ON tenant_lifecycle.state;
CREATE POLICY tlc_state_tenant_isolation ON tenant_lifecycle.state
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS tlc_event_tenant_isolation ON tenant_lifecycle.event;
CREATE POLICY tlc_event_tenant_isolation ON tenant_lifecycle.event
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE tenant_lifecycle.state    IS 'P4 §5.9 / FR-TLC-1: one-row-per-tenant FSM head pointer.';
COMMENT ON TABLE tenant_lifecycle.event    IS 'P4 §5.9: append-only transition log; mirrors audit envelope.';
COMMENT ON TABLE tenant_lifecycle.sandbox  IS 'P4 §5.9 / FR-TLC-3: sandbox sub-pool config; sandbox_tenant_id is a child of parent_tenant_id.';
