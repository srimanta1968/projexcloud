-- Migration 001: sdk-media canonical schema per P4-Operational-Billing-DataModel §4.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: media.{blob, signed_url, transcode_job}
-- Pool placement: Admin Pool (metadata only); blob bytes live in S3 per-tenant prefix.
-- FR-MED-1..5 per PRD §5.1.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS media;

-- media.blob — metadata for every blob (bytes in S3) per §4.1
-- encounter_id FK points to P5 encounter; nullable for non-encounter-bound media.
-- vault_key_ref points at the per-tenant or per-encounter key from vault.key.
CREATE TABLE IF NOT EXISTS media.blob (
  blob_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  encounter_id   UUID,
  persona_id     UUID NOT NULL,
  s3_key         TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  byte_size      BIGINT NOT NULL,
  vault_key_ref  UUID NOT NULL,
  checksum       BYTEA NOT NULL,
  variants       JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'uploading'
                   CHECK (status IN ('uploading','ready','transcoded','shredded'))
);

CREATE INDEX IF NOT EXISTS blob_tenant_idx       ON media.blob (tenant_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS blob_encounter_idx    ON media.blob (encounter_id) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS blob_persona_idx      ON media.blob (persona_id);
CREATE INDEX IF NOT EXISTS blob_status_idx       ON media.blob (status);

-- media.signed_url — issued URLs (audit-relevant) per §4.1
CREATE TABLE IF NOT EXISTS media.signed_url (
  url_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_id     UUID NOT NULL REFERENCES media.blob(blob_id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('upload','download')),
  persona_id  UUID NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signed_url_blob_idx    ON media.signed_url (blob_id, kind);
CREATE INDEX IF NOT EXISTS signed_url_active_idx  ON media.signed_url (expires_at);

-- media.transcode_job — per §4.1
-- output_blob_ids stores the resulting variant blob_ids (text[] of UUIDs).
-- billed_units captures the per-minute / per-MB amount used by sdk-billing.
CREATE TABLE IF NOT EXISTS media.transcode_job (
  job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blob_id          UUID NOT NULL REFERENCES media.blob(blob_id) ON DELETE CASCADE,
  pipeline         TEXT NOT NULL
                     CHECK (pipeline IN ('video-mp4-hls','image-optimize','pdf-thumbnail')),
  status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','succeeded','failed')),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  output_blob_ids  TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  billed_units     NUMERIC(18,6) NOT NULL DEFAULT 0,
  error_message    TEXT
);

CREATE INDEX IF NOT EXISTS transcode_blob_idx     ON media.transcode_job (blob_id);
CREATE INDEX IF NOT EXISTS transcode_queued_idx   ON media.transcode_job (status, blob_id)
  WHERE status IN ('queued','running');

COMMENT ON TABLE media.blob          IS 'Per P4-DataModel §4.1. Metadata only; bytes in S3 keyed by tenant prefix + s3_key. vault_key_ref drives envelope tier (per-tenant or per-encounter).';
COMMENT ON TABLE media.signed_url    IS 'Issued upload/download URLs - retained for audit per FR-MED-4.';
COMMENT ON TABLE media.transcode_job IS 'Per FR-MED-3. Pipeline enum: video-mp4-hls | image-optimize | pdf-thumbnail.';
