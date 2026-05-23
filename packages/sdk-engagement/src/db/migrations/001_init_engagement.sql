-- Migration 001: sdk-engagement (L5 + L6) per P5 DataModel §4.1.
-- Auto-applied by @projexlight/migration-runner. FR-EN-1..7.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS engagement;

CREATE TABLE IF NOT EXISTS engagement.encounter (
  encounter_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  kind                  TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open','in-progress','closed','sealed')),
  vault_key_ref         UUID,
  opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at             TIMESTAMPTZ,
  sealed_at             TIMESTAMPTZ,
  retention_policy      TEXT NOT NULL DEFAULT 'default-7y',
  retention_expires_at  TIMESTAMPTZ,
  parent_encounter_id   UUID REFERENCES engagement.encounter(encounter_id) ON DELETE RESTRICT,
  address_id            UUID,
  billing_ref           TEXT,
  CHECK ((state = 'sealed') = (sealed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS encounter_tenant_idx ON engagement.encounter (tenant_id, state);
CREATE INDEX IF NOT EXISTS encounter_kind_idx   ON engagement.encounter (kind, state);
CREATE INDEX IF NOT EXISTS encounter_parent_idx ON engagement.encounter (parent_encounter_id) WHERE parent_encounter_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS engagement.encounter_participant (
  participant_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id     UUID NOT NULL REFERENCES engagement.encounter(encounter_id) ON DELETE CASCADE,
  persona_id       UUID NOT NULL,
  role             TEXT NOT NULL,
  joined_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at          TIMESTAMPTZ,
  required         BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (encounter_id, persona_id, role)
);

CREATE INDEX IF NOT EXISTS participant_encounter_idx ON engagement.encounter_participant (encounter_id);
CREATE INDEX IF NOT EXISTS participant_persona_idx   ON engagement.encounter_participant (persona_id);

CREATE TABLE IF NOT EXISTS engagement.encounter_grant (
  grant_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id          UUID NOT NULL REFERENCES engagement.encounter(encounter_id) ON DELETE CASCADE,
  grantee_persona_id    UUID NOT NULL,
  issuer_persona_id     UUID NOT NULL,
  scope                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  capability_token_ref  TEXT
);

CREATE INDEX IF NOT EXISTS grant_encounter_idx ON engagement.encounter_grant (encounter_id);
CREATE INDEX IF NOT EXISTS grant_grantee_idx   ON engagement.encounter_grant (grantee_persona_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS grant_active_idx    ON engagement.encounter_grant (encounter_id) WHERE revoked_at IS NULL;

COMMENT ON TABLE engagement.encounter             IS 'L5 unit-of-work: visit/order/deal/session/capital-call/support. Per-encounter Vault key auto-issued at open, shredded at seal.';
COMMENT ON TABLE engagement.encounter_participant IS 'Typed persona refs with roles per encounter. required=TRUE participants gate closure.';
COMMENT ON TABLE engagement.encounter_grant       IS 'Time/scope-bounded tokens for non-participants (e.g., consulting nurse with chart.read for 8h).';
