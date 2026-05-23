-- Migration 001: sdk-persona canonical schema per P3-Canonical-Privacy-HDK-DataModel §5.1.
-- Auto-applied by @projexlight/migration-runner.
-- Tables: persona.{app_identity, membership, persona, role_assignment}.
-- FR-PSN-1..9.
--
-- NOTE: identity.app_identity / identity.tenant_membership already exist in P2 for
-- the JWT mint path. The persona.* schema is the canonical, persona-aware
-- registry used by every domain SDK from P3 onwards (FR-PSN-1..3).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS persona;

-- L2: persona.app_identity — one row per (person_id, app_id).
CREATE TABLE IF NOT EXISTS persona.app_identity (
  app_identity_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL,
  app_id            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','merged_into','erased')),
  merged_into_app_identity_id UUID REFERENCES persona.app_identity(app_identity_id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (person_id, app_id)
);

CREATE INDEX IF NOT EXISTS persona_app_identity_app_idx ON persona.app_identity (app_id, status);

-- L3: persona.membership — one row per (app_identity_id, tenant_id).
CREATE TABLE IF NOT EXISTS persona.membership (
  membership_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_identity_id   UUID NOT NULL REFERENCES persona.app_identity(app_identity_id) ON DELETE RESTRICT,
  tenant_id         UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','suspended','terminated')),
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at     TIMESTAMPTZ,
  UNIQUE (app_identity_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS persona_membership_tenant_idx ON persona.membership (tenant_id, status);

-- L4: persona.persona — typed by kind. Multiple personas per membership allowed (FR-PSN-5).
CREATE TABLE IF NOT EXISTS persona.persona (
  persona_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id             UUID NOT NULL REFERENCES persona.membership(membership_id) ON DELETE RESTRICT,
  kind                      TEXT NOT NULL,
  primary_role_template_id  UUID,
  bu_id                     UUID,
  persona_key_ref           UUID,
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','suspended','shredded')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  shredded_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS persona_membership_idx ON persona.persona (membership_id, status);
CREATE INDEX IF NOT EXISTS persona_kind_idx       ON persona.persona (kind, status);

-- persona.role_assignment — many-to-many between persona and role_template.
CREATE TABLE IF NOT EXISTS persona.role_assignment (
  assignment_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id        UUID NOT NULL REFERENCES persona.persona(persona_id) ON DELETE CASCADE,
  role_template_id  UUID NOT NULL,
  assigned_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  assigned_by       TEXT
);

CREATE INDEX IF NOT EXISTS role_assignment_persona_idx ON persona.role_assignment (persona_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS role_assignment_role_idx    ON persona.role_assignment (role_template_id) WHERE revoked_at IS NULL;

-- persona.persona_extension — polymorphic extension container (FR-PSN-6).
-- Per DataModel §5.1 the canonical extension table is per-vertical and lives
-- in the App Pool. This admin-pool registry records WHICH app pool / table
-- holds the extension data for a given persona, plus a jsonb shadow for cases
-- where the vertical has not yet declared a typed extension table. It lets
-- the platform answer "where does donor_history for persona X live" without
-- the vertical SDK having to ship a per-pool catalog.
CREATE TABLE IF NOT EXISTS persona.persona_extension (
  extension_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona_id             UUID NOT NULL REFERENCES persona.persona(persona_id) ON DELETE CASCADE,
  kind                   TEXT NOT NULL,
  tenant_id              UUID NOT NULL,
  extension_pool_index   TEXT,
  extension_table        TEXT,
  extension_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (persona_id, kind)
);

CREATE INDEX IF NOT EXISTS persona_extension_persona_idx ON persona.persona_extension (persona_id);
CREATE INDEX IF NOT EXISTS persona_extension_tenant_idx  ON persona.persona_extension (tenant_id, kind);

COMMENT ON TABLE persona.app_identity IS 'L2: one row per (person, app). FR-PSN-1.';
COMMENT ON TABLE persona.membership   IS 'L3: per (app_identity, tenant). FR-PSN-2.';
COMMENT ON TABLE persona.persona      IS 'L4: typed personas, multi-per-membership allowed. Independent shred (FR-PSN-7).';
COMMENT ON TABLE persona.role_assignment IS 'Many-to-many persona ↔ role_template. FR-PSN-4.';
COMMENT ON TABLE persona.persona_extension IS 'Polymorphic persona-extension container + per-vertical app-pool table registry. FR-PSN-6.';
