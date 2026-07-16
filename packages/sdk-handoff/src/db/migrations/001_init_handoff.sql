-- Migration 001: sdk-handoff — Sales→Delivery handoff record + lifecycle.
-- P15 · E2. Auto-applied by the migration runner at boot.
--
-- New SOP-gap object (no projex_crm parity). One handoff row per closed-won deal
-- being transitioned to onboarding/CS. Identity-aligned (persona-keyed), tenant-
-- scoped. The accept/reject gate (sdk-approval) and orchestration saga
-- (sdk-workflow) are referenced by loose id (approval_id / workflow_run_id).
--
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS handoff;

CREATE TABLE IF NOT EXISTS handoff.handoff (
  handoff_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  -- Loose reference to the source crm.deal (cross-SDK; no hard FK).
  deal_id              UUID,
  from_persona_id      UUID NOT NULL,
  cs_owner_persona_id  UUID,
  cs_backup_persona_id UUID,
  kickoff_ref          TEXT,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','pending','accepted','rejected','completed','cancelled')),
  prework              JSONB NOT NULL DEFAULT '[]'::jsonb,
  promises             JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks                JSONB NOT NULL DEFAULT '[]'::jsonb,
  integrations         JSONB NOT NULL DEFAULT '[]'::jsonb,
  milestones           JSONB NOT NULL DEFAULT '[]'::jsonb,
  reject_reason        TEXT,
  workflow_run_id      UUID,
  approval_id          UUID,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at         TIMESTAMPTZ,
  accepted_at          TIMESTAMPTZ,
  rejected_at          TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS handoff_tenant_idx   ON handoff.handoff (tenant_id, status);
CREATE INDEX IF NOT EXISTS handoff_deal_idx     ON handoff.handoff (deal_id) WHERE deal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS handoff_cs_owner_idx ON handoff.handoff (cs_owner_persona_id) WHERE cs_owner_persona_id IS NOT NULL;

COMMENT ON SCHEMA handoff IS 'sdk-handoff · P15·E2 Sales→Delivery handoff with accept/reject.';
COMMENT ON TABLE  handoff.handoff IS 'Handoff record + lifecycle: draft -> pending -> accepted/rejected -> completed/cancelled. Holds owner/backup, promises, risks, integrations, milestones.';
COMMENT ON COLUMN handoff.handoff.deal_id IS 'Loose reference to the source crm.deal (cross-SDK, no hard FK).';
