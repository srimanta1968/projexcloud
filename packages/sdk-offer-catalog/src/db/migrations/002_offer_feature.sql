-- Migration 002: sdk-offer-catalog — feature-status matrix. P15 · E1.
-- Auto-applied by the migration runner at boot.
--
-- Each row is one feature's status WITHIN a specific immutable offer_version —
-- FK-pinned to that version (ON DELETE RESTRICT), so the matrix can never drift
-- from the versioned truth and a version that carries features cannot be
-- deleted. Additive to migration 001. Idempotent; down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS offer_catalog.offer_feature (
  offer_feature_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  -- Pinned to one immutable version; RESTRICT keeps the matrix and the version
  -- lifecycle in lockstep.
  offer_version_id  UUID NOT NULL REFERENCES offer_catalog.offer_version(offer_version_id) ON DELETE RESTRICT,
  feature_key       TEXT NOT NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'included'
                      CHECK (status IN ('included','excluded','beta','roadmap','add_on','deprecated')),
  value             TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT offer_feature_unique UNIQUE (offer_version_id, feature_key)
);

CREATE INDEX IF NOT EXISTS offer_feature_version_idx
  ON offer_catalog.offer_feature (offer_version_id, status);
CREATE INDEX IF NOT EXISTS offer_feature_tenant_idx
  ON offer_catalog.offer_feature (tenant_id, feature_key);

COMMENT ON TABLE  offer_catalog.offer_feature IS 'Feature-status matrix pinned to an immutable offer_version (RESTRICT). One row per (version, feature_key).';
COMMENT ON COLUMN offer_catalog.offer_feature.status IS 'included/excluded/beta/roadmap/add_on/deprecated — the per-version feature-status matrix.';
