-- Migration 001: sdk-social per P5 DataModel §10. Auto-applied via api-gateway.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS social;

CREATE TABLE IF NOT EXISTS social.handle (
  handle_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  network                TEXT NOT NULL
                           CHECK (network IN ('twitter','linkedin','instagram','facebook','tiktok')),
  external_handle_id     TEXT NOT NULL,
  authorized_persona_id  UUID NOT NULL,
  authorized_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, network, external_handle_id)
);

CREATE INDEX IF NOT EXISTS social_handle_tenant_idx ON social.handle (tenant_id, network);

CREATE TABLE IF NOT EXISTS social.interaction (
  interaction_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle_id                   UUID NOT NULL REFERENCES social.handle(handle_id) ON DELETE CASCADE,
  kind                        TEXT NOT NULL CHECK (kind IN ('dm','comment','mention','review')),
  author_external_id          TEXT NOT NULL,
  author_persona_id           UUID,
  body                        TEXT,
  received_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  captured_lead_contact_id    UUID
);

CREATE INDEX IF NOT EXISTS social_interaction_handle_idx ON social.interaction (handle_id, received_at DESC);
CREATE INDEX IF NOT EXISTS social_interaction_lead_idx   ON social.interaction (captured_lead_contact_id) WHERE captured_lead_contact_id IS NOT NULL;

COMMENT ON TABLE social.handle      IS 'Authorized social channel per (tenant, network, external_id).';
COMMENT ON TABLE social.interaction IS 'Inbound DM/comment/mention/review; emits social.lead.captured.v1 on lead resolution.';
