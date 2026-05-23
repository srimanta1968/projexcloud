-- Migration 001: sdk-workflow canonical schema per P4-Operational-Billing-DataModel §7.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: workflow.{definition, run, step, compensation}
-- Pool placement: Admin Pool (registry) + Temporal backend per pool-family namespace.
-- FR-WFL-1..5 per PRD §5.4.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS workflow;

-- workflow.definition per §7.1
-- step_specs jsonb describes the ordered step pipeline + compensation hooks.
-- namespace = one per pool family (admin/healthcare/realty etc) per FR-WFL-4.
CREATE TABLE IF NOT EXISTS workflow.definition (
  workflow_def_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  version          TEXT NOT NULL DEFAULT '1.0.0',
  namespace        TEXT NOT NULL DEFAULT 'admin',
  step_specs       JSONB NOT NULL DEFAULT '[]'::jsonb,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('draft','active','deprecated')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One definition per (name, version, namespace) — semver enforces uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS def_name_version_uniq
  ON workflow.definition (name, version, namespace);
CREATE INDEX IF NOT EXISTS def_active_idx
  ON workflow.definition (name, namespace) WHERE status = 'active';

-- workflow.run per §7.1
-- run_id mirrors Temporal RunID for cross-system trace alignment.
-- envelope jsonb carries six-layer context propagated to every step (FR-WFL-1).
CREATE TABLE IF NOT EXISTS workflow.run (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_def_id   UUID NOT NULL REFERENCES workflow.definition(workflow_def_id) ON DELETE RESTRICT,
  tenant_id         UUID,
  persona_id        UUID,
  trace_id          TEXT,
  envelope          JSONB NOT NULL DEFAULT '{}'::jsonb,
  input             JSONB NOT NULL DEFAULT '{}'::jsonb,
  output            JSONB,
  status            TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed','compensated','terminated')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  error_message     TEXT
);

CREATE INDEX IF NOT EXISTS run_def_idx     ON workflow.run (workflow_def_id, started_at DESC);
CREATE INDEX IF NOT EXISTS run_tenant_idx  ON workflow.run (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS run_status_idx  ON workflow.run (status);
CREATE INDEX IF NOT EXISTS run_trace_idx   ON workflow.run (trace_id) WHERE trace_id IS NOT NULL;

-- workflow.step per §7.1 - per-step records (input, output, status).
CREATE TABLE IF NOT EXISTS workflow.step (
  step_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         UUID NOT NULL REFERENCES workflow.run(run_id) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','running','succeeded','failed','compensated','skipped')),
  input          JSONB NOT NULL DEFAULT '{}'::jsonb,
  output         JSONB,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  error_message  TEXT
);

CREATE INDEX IF NOT EXISTS step_run_idx ON workflow.step (run_id, idx);

-- workflow.compensation per §7.1 - per-step rollback anchors.
CREATE TABLE IF NOT EXISTS workflow.compensation (
  compensation_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id          UUID NOT NULL REFERENCES workflow.step(step_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','executing','succeeded','failed')),
  executed_at      TIMESTAMPTZ,
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS comp_step_idx ON workflow.compensation (step_id);

COMMENT ON TABLE workflow.definition   IS 'Per P4-DataModel §7.1. step_specs jsonb describes ordered pipeline + compensation hooks. namespace per pool family (FR-WFL-4).';
COMMENT ON TABLE workflow.run          IS 'Per FR-WFL-1. envelope jsonb propagates six-layer context to every step; trace_id links to OTel.';
COMMENT ON TABLE workflow.step         IS 'Per FR-WFL-3. status transitions pending->running->succeeded/failed/compensated/skipped.';
COMMENT ON TABLE workflow.compensation IS 'Per FR-WFL-3. Saga rollback anchor; reverse-order execution on mid-saga failure.';
