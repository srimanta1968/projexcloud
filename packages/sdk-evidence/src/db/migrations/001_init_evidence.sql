-- Migration 001: sdk-evidence canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §8.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Pool placement: Evidence Pool (metadata) + S3 (raw + variant blobs).
-- This migration lands the metadata side; the blob layer is sdk-media's job.

CREATE SCHEMA IF NOT EXISTS evidence;

-- ---------------------------------------------------------------------------
-- evidence.capture — one row per provenance-stamped capture.
--
-- encounter_id is REQUIRED (FR-EVD-5); sealing an encounter (handled by
-- sdk-engagement) blocks new captures referencing it. The status enum
-- also tracks per-encounter retention shred (FR-EVD-6).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence.capture (
  capture_id              TEXT PRIMARY KEY,
  tenant_id               UUID NOT NULL,
  -- Logical FK to engagement.encounter; required, blocks-on-seal in app code.
  -- Type matches engagement.encounter.encounter_id (UUID).
  encounter_id            UUID NOT NULL,
  capturer_persona_id     UUID NOT NULL,
  -- Logical FK to device.device.
  device_uuid             TEXT NOT NULL,
  device_attestation_id   TEXT NOT NULL,
  -- Logical FK to media.blob; raw is never overwritten (FR-EVD-2).
  raw_blob_id             TEXT NOT NULL,
  captured_at             TIMESTAMPTZ NOT NULL,
  lat                     NUMERIC,
  lng                     NUMERIC,
  altitude                NUMERIC,
  imu_signature           BYTEA,
  -- Logical FK to consent.receipt; capture-purpose consent.
  consent_ref             TEXT NOT NULL,
  retention_class         TEXT NOT NULL,
  retention_expires_at    TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','sealed','shredded')
  )
);

CREATE INDEX IF NOT EXISTS evidence_capture_tenant_idx
  ON evidence.capture (tenant_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS evidence_capture_encounter_idx
  ON evidence.capture (encounter_id);
CREATE INDEX IF NOT EXISTS evidence_capture_retention_idx
  ON evidence.capture (retention_expires_at)
  WHERE retention_expires_at IS NOT NULL AND status = 'active';

-- ---------------------------------------------------------------------------
-- evidence.variant — edits, annotations, watermarks. Raw kept separately
-- in evidence.capture.raw_blob_id (edits NEVER overwrite raw per FR-EVD-2).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence.variant (
  variant_id              TEXT PRIMARY KEY,
  capture_id              TEXT NOT NULL REFERENCES evidence.capture(capture_id) ON DELETE CASCADE,
  kind                    TEXT NOT NULL CHECK (
    kind IN ('edited','watermarked','annotated','redacted')
  ),
  -- Logical FK to media.blob.
  variant_blob_id         TEXT NOT NULL,
  edit_log                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_persona_id   UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_variant_capture_idx
  ON evidence.variant (capture_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- evidence.chain_of_custody — append-only hash chain per capture.
--
-- (capture_id, seq) is unique → gaps in seq indicate tampering. entry_hash
-- = sha256(prev_hash || blob_checksum || action || actor || seq); the
-- legal-export verifier (sdk-evidence.verifyChain) re-computes the chain
-- and compares to entry_hash. audit_entry_id cross-links into sdk-audit
-- for the universal-audit narrative.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence.chain_of_custody (
  entry_id          TEXT PRIMARY KEY,
  capture_id        TEXT NOT NULL REFERENCES evidence.capture(capture_id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq >= 0),
  action            TEXT NOT NULL CHECK (
    action IN ('captured','transferred','edited','watermarked','exported','accessed')
  ),
  actor_persona_id  UUID NOT NULL,
  blob_checksum     BYTEA NOT NULL,
  prev_hash         BYTEA NOT NULL,
  entry_hash        BYTEA NOT NULL,
  -- Logical FK to audit.entry for cross-chain reconciliation.
  audit_entry_id    TEXT NOT NULL,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS evidence_chain_capture_seq_uq
  ON evidence.chain_of_custody (capture_id, seq);
CREATE INDEX IF NOT EXISTS evidence_chain_capture_idx
  ON evidence.chain_of_custody (capture_id, seq);

-- ---------------------------------------------------------------------------
-- evidence.legal_export — generated bundle (signed PDF + JSONL + media).
-- jurisdiction selects the bundle format (multi-jurisdiction support per
-- FR-EVD-8); chain_verifications stores per-capture verify results at
-- export time so a re-verification can detect post-export tampering.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS evidence.legal_export (
  export_id              TEXT PRIMARY KEY,
  requestor_persona_id   UUID NOT NULL,
  jurisdiction           TEXT NOT NULL,
  capture_ids            TEXT[] NOT NULL,
  artifact_s3_key        TEXT NOT NULL,
  signature_envelope     BYTEA NOT NULL,
  chain_verifications    JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_legal_export_requestor_idx
  ON evidence.legal_export (requestor_persona_id, generated_at DESC);

COMMENT ON SCHEMA evidence IS 'sdk-evidence (P7 §5.5). Chain-of-custody linchpin: captures + variants + hash chain + legal-export bundles. Last domain SDK to ship in v3.1.';
