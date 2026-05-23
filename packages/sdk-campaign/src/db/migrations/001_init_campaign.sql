-- Migration 001: sdk-campaign per P5 DataModel §9. Auto-applied via api-gateway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS campaign;

CREATE TABLE IF NOT EXISTS campaign.campaign (
  campaign_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','scheduled','running','paused','completed')),
  variant_flag_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_tenant_idx ON campaign.campaign (tenant_id, status);

CREATE TABLE IF NOT EXISTS campaign.segment (
  segment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id          UUID NOT NULL REFERENCES campaign.campaign(campaign_id) ON DELETE CASCADE,
  dsl                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  population_estimate  INT,
  last_computed_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS campaign.journey (
  journey_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   UUID NOT NULL REFERENCES campaign.campaign(campaign_id) ON DELETE CASCADE,
  steps         JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS campaign.journey_run (
  run_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_id          UUID NOT NULL REFERENCES campaign.journey(journey_id) ON DELETE CASCADE,
  subject_persona_id  UUID NOT NULL,
  current_step        INT NOT NULL DEFAULT 0,
  state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active','paused','completed','exited')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_advanced_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS journey_run_journey_idx ON campaign.journey_run (journey_id, state);
CREATE INDEX IF NOT EXISTS journey_run_subject_idx ON campaign.journey_run (subject_persona_id);

COMMENT ON TABLE campaign.campaign     IS 'Marketing campaign; status drives whether journeys advance.';
COMMENT ON TABLE campaign.segment      IS 'Segment DSL over the event stream + projection.subject_view.';
COMMENT ON TABLE campaign.journey      IS 'Steps jsonb (delays, branches, notification refs).';
COMMENT ON TABLE campaign.journey_run  IS 'Per-subject journey instance.';
