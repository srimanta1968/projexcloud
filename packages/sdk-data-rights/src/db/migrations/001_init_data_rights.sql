-- Migration 001: sdk-data-rights canonical schema per P3-Canonical-Privacy-HDK-DataModel §7.1.
-- G5 closer. Auto-applied by @projexlight/migration-runner.
-- Tables: data_rights.{person_pool_residency, request, execution, certificate, reconciliation_run}.
-- FR-DR-1..9.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS data_rights;

-- data_rights.person_pool_residency — the G5 registry. Written on first-touch
-- by every data-bearing SDK so DSAR knows where to fan out (FR-DR-1).
CREATE TABLE IF NOT EXISTS data_rights.person_pool_residency (
  residency_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id           UUID NOT NULL,
  pool_index          TEXT NOT NULL,
  tenant_id           UUID NOT NULL,
  data_classes        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  first_touched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_touched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reconciled_at  TIMESTAMPTZ,
  UNIQUE (person_id, pool_index, tenant_id)
);

CREATE INDEX IF NOT EXISTS residency_person_idx ON data_rights.person_pool_residency (person_id);
CREATE INDEX IF NOT EXISTS residency_pool_idx   ON data_rights.person_pool_residency (pool_index, tenant_id);

-- data_rights.request — DSAR workflow state machine (FR-DR-2/3/4/9).
CREATE TABLE IF NOT EXISTS data_rights.request (
  request_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL,
  tenant_id         UUID,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('access','erasure','rectification','restriction','objection','portability')),
  jurisdiction      TEXT NOT NULL DEFAULT 'GDPR',
  sla_deadline      TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'submitted'
                      CHECK (status IN ('submitted','identity-verified','approval-pending',
                                        'grace-period','executing','certificate-issued','audited','rejected')),
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at       TIMESTAMPTZ,
  approved_at       TIMESTAMPTZ,
  grace_until       TIMESTAMPTZ,
  executed_at       TIMESTAMPTZ,
  certificate_at    TIMESTAMPTZ,
  approval_policy   TEXT NOT NULL DEFAULT 'manager-approval'
                      CHECK (approval_policy IN ('auto','manager-approval','cross-tenant-approval')),
  approval_ref      UUID
);

CREATE INDEX IF NOT EXISTS request_person_idx ON data_rights.request (person_id, status);
CREATE INDEX IF NOT EXISTS request_status_idx ON data_rights.request (status, sla_deadline);

-- data_rights.execution — per-pool fan-out execution.
CREATE TABLE IF NOT EXISTS data_rights.execution (
  execution_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id            UUID NOT NULL REFERENCES data_rights.request(request_id) ON DELETE CASCADE,
  pool_index            TEXT NOT NULL,
  action                TEXT NOT NULL
                          CHECK (action IN ('shred-person-key','shred-persona-key','shred-encounter-key','export','rectify')),
  shred_target_key_id   UUID,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','running','succeeded','failed')),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  audit_entry_id        UUID,
  error_detail          TEXT
);

CREATE INDEX IF NOT EXISTS execution_request_idx ON data_rights.execution (request_id);
CREATE INDEX IF NOT EXISTS execution_status_idx  ON data_rights.execution (status);

-- data_rights.certificate — signed completion certificate (FR-DR-7).
CREATE TABLE IF NOT EXISTS data_rights.certificate (
  certificate_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id              UUID NOT NULL REFERENCES data_rights.request(request_id) ON DELETE CASCADE,
  format                  TEXT NOT NULL DEFAULT 'pdf' CHECK (format IN ('pdf','jsonl')),
  artifact_s3_key         TEXT,
  shred_proofs            JSONB NOT NULL DEFAULT '{}'::jsonb,
  signed_by_audit_entry_id UUID,
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS certificate_request_idx ON data_rights.certificate (request_id);

-- data_rights.reconciliation_run — weekly job comparing residency to actual data.
CREATE TABLE IF NOT EXISTS data_rights.reconciliation_run (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  discrepancies     JSONB NOT NULL DEFAULT '[]'::jsonb,
  state             TEXT NOT NULL DEFAULT 'green'
                      CHECK (state IN ('green','red'))
);

CREATE INDEX IF NOT EXISTS reconciliation_state_idx ON data_rights.reconciliation_run (state, started_at DESC);

COMMENT ON TABLE data_rights.person_pool_residency IS 'G5 registry: first-touch records of every (person, pool, tenant) tuple. Drives DSAR fan-out.';
COMMENT ON TABLE data_rights.request             IS 'DSAR / right-to-erasure workflow state machine. Per-jurisdiction SLA.';
COMMENT ON TABLE data_rights.execution           IS 'Per-pool fan-out execution of a DSAR request.';
COMMENT ON TABLE data_rights.certificate         IS 'Signed cert of completion. shred_proofs maps pool_index → audit_entry_hash.';
COMMENT ON TABLE data_rights.reconciliation_run  IS 'Weekly residency vs actual-data reconciliation. state=red halts DSAR completions.';
