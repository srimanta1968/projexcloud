-- Migration 001: sdk-approval canonical schema per P4-Operational-Billing-DataModel §11.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: approval.{route, request, step}
-- Pool: App Pool (per tenant)
-- FR-APP-1..7 per PRD §5.8.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS approval;

-- approval.route per §11.1 - reusable route definition.
-- steps jsonb encodes the ordered chain with parallel M-of-N support, e.g.:
--   [
--     { "name": "manager",  "kind": "single",  "approver_persona_id": "...", "sla_minutes": 60 },
--     { "name": "finance",  "kind": "m-of-n", "m": 2, "approvers": [...],    "sla_minutes": 120 }
--   ]
-- delegation_rules jsonb encodes OOO handling, e.g.:
--   { "<persona>": { "delegate_to": "...", "from": "...", "to": "..." } }
CREATE TABLE IF NOT EXISTS approval.route (
  route_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  kind_pattern        TEXT,
  steps               JSONB NOT NULL DEFAULT '[]'::jsonb,
  delegation_rules    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('draft','active','deprecated')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS route_tenant_name_uniq
  ON approval.route (tenant_id, name) WHERE status <> 'deprecated';
CREATE INDEX IF NOT EXISTS route_kind_pattern_idx
  ON approval.route (tenant_id, kind_pattern) WHERE status = 'active';

-- approval.request per §11.1 - one row per "this thing needs approval".
-- subject_kind enum is open-ended TEXT to support arbitrary subject types
-- (payment.refund, tenant.suspend, data_rights.delete, agent.beyond_scope).
CREATE TABLE IF NOT EXISTS approval.request (
  request_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id                UUID NOT NULL REFERENCES approval.route(route_id) ON DELETE RESTRICT,
  tenant_id               UUID NOT NULL,
  subject_kind            TEXT NOT NULL,
  subject_id              TEXT NOT NULL,
  initiator_persona_id    UUID NOT NULL,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected','escalated','timed-out','cancelled')),
  final_decision          TEXT
                            CHECK (final_decision IS NULL OR final_decision IN ('approve','reject')),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at             TIMESTAMPTZ
);

-- One open request per (tenant, subject_kind, subject_id) — re-requesting
-- approval while one is in flight should reuse the existing request, not
-- create a parallel chain. Partial UNIQUE enforces this.
CREATE UNIQUE INDEX IF NOT EXISTS req_subject_open_uniq
  ON approval.request (tenant_id, subject_kind, subject_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS req_tenant_idx
  ON approval.request (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS req_status_idx
  ON approval.request (status, requested_at);

-- approval.step per §11.1 - per-step records.
-- step_index = position within route.steps jsonb (0-indexed).
-- For M-of-N steps, multiple step rows share the same step_index (one per
-- candidate approver); the "step is done" condition counts M approvals.
CREATE TABLE IF NOT EXISTS approval.step (
  step_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           UUID NOT NULL REFERENCES approval.request(request_id) ON DELETE CASCADE,
  step_index           INTEGER NOT NULL,
  approver_persona_id  UUID NOT NULL,
  decision             TEXT
                         CHECK (decision IS NULL OR decision IN ('approve','reject')),
  reason               TEXT,
  sla_deadline         TIMESTAMPTZ,
  acted_at             TIMESTAMPTZ,
  delegated_from       UUID,
  auto_escalated       BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS step_request_idx
  ON approval.step (request_id, step_index);
-- For the SLA timer scheduler to find pending steps past their deadline.
CREATE INDEX IF NOT EXISTS step_pending_sla_idx
  ON approval.step (sla_deadline)
  WHERE decision IS NULL AND acted_at IS NULL;

COMMENT ON TABLE approval.route   IS 'Per P4-DataModel §11.1. steps jsonb supports single + m-of-n + role-template kinds with per-step SLA.';
COMMENT ON TABLE approval.request IS 'Per §11.1. Partial UNIQUE on (tenant, subject_kind, subject_id) WHERE status=pending prevents parallel chains.';
COMMENT ON TABLE approval.step    IS 'Per §11.1. step_index references route.steps jsonb position; multiple rows for M-of-N.';
