-- Migration 001: sdk-crm per P5 DataModel §5.1. Auto-applied via api-gateway.
-- FR-CRM-1..5. Contact keyed by persona (AC-6: no parallel work-unit primitive).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS crm;

CREATE TABLE IF NOT EXISTS crm.contact (
  contact_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  persona_id        UUID NOT NULL,
  lifecycle_stage   TEXT NOT NULL DEFAULT 'lead'
                      CHECK (lifecycle_stage IN ('lead','prospect','customer','churned','former')),
  source            TEXT,
  owner_persona_id  UUID,
  custom_fields     JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_refs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, persona_id)
);

CREATE INDEX IF NOT EXISTS crm_contact_tenant_idx ON crm.contact (tenant_id, lifecycle_stage);
CREATE INDEX IF NOT EXISTS crm_contact_owner_idx  ON crm.contact (owner_persona_id);

CREATE TABLE IF NOT EXISTS crm.deal (
  deal_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  encounter_id       UUID NOT NULL,
  contact_id         UUID REFERENCES crm.contact(contact_id) ON DELETE SET NULL,
  name               TEXT NOT NULL,
  amount             NUMERIC(18,4),
  currency           CHAR(3),
  stage              TEXT NOT NULL DEFAULT 'qualifying'
                       CHECK (stage IN ('qualifying','proposal','negotiation','closed-won','closed-lost')),
  close_probability  NUMERIC(5,2),
  custom_fields      JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_refs      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_deal_tenant_idx    ON crm.deal (tenant_id, stage);
CREATE INDEX IF NOT EXISTS crm_deal_encounter_idx ON crm.deal (encounter_id);

CREATE TABLE IF NOT EXISTS crm.activity (
  activity_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id       UUID NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('call','email','meeting','note','task')),
  actor_persona_id   UUID NOT NULL,
  summary            TEXT,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_activity_encounter_idx ON crm.activity (encounter_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS crm.lead (
  lead_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  source            TEXT NOT NULL,
  contact_id        UUID REFERENCES crm.contact(contact_id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','qualified','unqualified','converted')),
  score             NUMERIC(5,2),
  custom_fields     JSONB NOT NULL DEFAULT '{}'::jsonb,
  external_refs     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_lead_tenant_idx ON crm.lead (tenant_id, status);

COMMENT ON TABLE crm.contact  IS 'Persona-keyed contact (FR-CRM-1). One row per (tenant, persona).';
COMMENT ON TABLE crm.deal     IS 'Deal cycle is an Encounter (FR-CRM-2). encounter_id FK required.';
COMMENT ON TABLE crm.activity IS 'Sub-unit of Encounter (FR-CRM-3). NOT a separate timeline.';
