-- Migration 001: sdk-offer-catalog — versioned offer truth + feature-status matrix.
-- P15 · E1. Auto-applied by the migration runner at boot.
--
-- offer + offer_version cloned from the sdk-taxonomy.version pattern (immutable,
-- lineage via parent_version_id, ON DELETE RESTRICT). The feature-status matrix
-- (offer_feature) is added in migration 002. New SOP-gap object — no projex_crm
-- parity. Tenant-scoped, identity-aligned (owner/created_by persona).
--
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS offer_catalog;

-- ---------------------------------------------------------------- offer_catalog.offer
-- Stable offer identity. Content lives in immutable offer_version rows.
CREATE TABLE IF NOT EXISTS offer_catalog.offer (
  offer_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL,
  description       TEXT,
  owner_persona_id  UUID,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS offer_tenant_idx ON offer_catalog.offer (tenant_id);

-- ---------------------------------------------------------------- offer_catalog.offer_version
-- Immutable versioned truth (clone of taxonomy.version). Never updated in place
-- and never deleted (RESTRICT) — a new version supersedes an old one. Status
-- enum adds live/beta/roadmap (not present in any existing SDK enum).
CREATE TABLE IF NOT EXISTS offer_catalog.offer_version (
  offer_version_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  offer_id              UUID NOT NULL REFERENCES offer_catalog.offer(offer_id) ON DELETE RESTRICT,
  version               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','live','beta','roadmap','retired')),
  parent_version_id     UUID REFERENCES offer_catalog.offer_version(offer_version_id) ON DELETE RESTRICT,
  title                 TEXT,
  body                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  price                 NUMERIC(18,4),
  currency              CHAR(3),
  activated_at          TIMESTAMPTZ,
  created_by_persona_id UUID,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offer_version_unique UNIQUE (tenant_id, offer_id, version)
);

CREATE INDEX IF NOT EXISTS offer_version_offer_idx
  ON offer_catalog.offer_version (offer_id, status);
CREATE INDEX IF NOT EXISTS offer_version_lineage_idx
  ON offer_catalog.offer_version (parent_version_id) WHERE parent_version_id IS NOT NULL;
-- At most one live version per offer — the resolve-current-with-fallback guard
-- (TK, Publish/Activate/Resolve feature).
CREATE UNIQUE INDEX IF NOT EXISTS offer_version_one_live_idx
  ON offer_catalog.offer_version (tenant_id, offer_id) WHERE status = 'live';

COMMENT ON SCHEMA offer_catalog IS 'sdk-offer-catalog · P15·E1 versioned offer truth + feature-status matrix.';
COMMENT ON TABLE  offer_catalog.offer         IS 'Stable offer identity; content lives in immutable offer_version rows.';
COMMENT ON TABLE  offer_catalog.offer_version IS 'Immutable versioned offer truth (clone of taxonomy.version). RESTRICT — never deleted; superseded by a new version.';
COMMENT ON COLUMN offer_catalog.offer_version.status IS 'draft -> beta/roadmap -> live -> retired. At most one live per offer.';
