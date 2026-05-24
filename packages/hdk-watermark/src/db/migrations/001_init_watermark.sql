-- Migration 001: hdk-watermark server anchor per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §13.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Lands AFTER sdk-evidence (variant_id FK target) in the migration runner.

CREATE SCHEMA IF NOT EXISTS hdk_watermark;

CREATE TABLE IF NOT EXISTS hdk_watermark.application (
  application_id     TEXT PRIMARY KEY,
  -- Logical FK to evidence.variant. Logical (not hard) so the package can
  -- ship independently and pool-migration stays safe.
  variant_id         TEXT NOT NULL,
  scheme             TEXT NOT NULL CHECK (
    scheme IN ('visible','invisible','cryptographic')
  ),
  -- Encrypted payload envelope (vault key id + sealed bytes).
  payload_envelope   BYTEA NOT NULL,
  applied_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hdk_watermark_variant_idx
  ON hdk_watermark.application (variant_id, applied_at DESC);

COMMENT ON SCHEMA hdk_watermark IS 'hdk-watermark (P7 §5.9, datamodel §13). Server anchor for evidence-integrity watermark applications.';
