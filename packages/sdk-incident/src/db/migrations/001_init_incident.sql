-- Migration 001: sdk-incident — exception/incident record + lifecycle. P15 · E3.
-- Auto-applied by the migration runner at boot.
--
-- New SOP-gap object (no projex_crm parity). One row per operational
-- exception/incident. Identity-aligned (persona-keyed), tenant-scoped. The
-- evidence timeline (→ sdk-audit) and REST surface land in later P15·E3 tasks.
--
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS incident;

CREATE TABLE IF NOT EXISTS incident.incident (
  incident_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  incident_type          TEXT NOT NULL,
  title                  TEXT NOT NULL,
  description            TEXT,
  severity               TEXT NOT NULL DEFAULT 'medium'
                           CHECK (severity IN ('low','medium','high','critical')),
  status                 TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open','investigating','mitigated','resolved','closed','cancelled')),
  affected_records       JSONB NOT NULL DEFAULT '[]'::jsonb,
  root_cause             TEXT,
  recovery               TEXT,
  verification           TEXT,
  owner_persona_id       UUID,
  reported_by_persona_id UUID,
  source                 TEXT,
  subject_ref            TEXT,
  sla_due_at             TIMESTAMPTZ,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  opened_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  detected_at            TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  closed_at              TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incident_tenant_idx ON incident.incident (tenant_id, status);
CREATE INDEX IF NOT EXISTS incident_owner_idx  ON incident.incident (owner_persona_id) WHERE owner_persona_id IS NOT NULL;
-- SLA scan: find still-open incidents whose deadline is near/past (TK, SLA scan).
CREATE INDEX IF NOT EXISTS incident_sla_idx
  ON incident.incident (sla_due_at)
  WHERE status NOT IN ('resolved','closed','cancelled');

COMMENT ON SCHEMA incident IS 'sdk-incident · P15·E3 exception/incident record & evidence.';
COMMENT ON TABLE  incident.incident IS 'Incident record + lifecycle: open -> investigating -> mitigated -> resolved -> closed. Holds type, affected_records, root_cause, recovery, verification, owner, SLA.';
COMMENT ON COLUMN incident.incident.sla_due_at IS 'SLA deadline; the incident_sla_idx partial index powers the SLA breach scan.';
