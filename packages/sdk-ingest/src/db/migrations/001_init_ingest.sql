-- sdk-ingest 001 — generic ETL landing table (P9.2 / Epic B, TK-3468).
-- Auto-applied on boot by @projexlight/migration-runner. The ingest batch
-- endpoint lands external records here idempotently; downstream SDKs project
-- them into their own canonical tables.

CREATE SCHEMA IF NOT EXISTS ingest;

CREATE TABLE IF NOT EXISTS ingest.record (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid,
  entity          text NOT NULL,
  external_id     text,
  idempotency_key text NOT NULL,
  payload         jsonb NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  -- idempotent per (entity, batch key, external row id): re-running a batch
  -- upserts rather than duplicating.
  UNIQUE (entity, idempotency_key, external_id)
);
CREATE INDEX IF NOT EXISTS ingest_record_entity_idx    ON ingest.record (entity);
CREATE INDEX IF NOT EXISTS ingest_record_tenant_idx    ON ingest.record (tenant_id);

COMMENT ON TABLE ingest.record IS 'ETL landing table (P9.2). External data enters here via POST /api/ingest/:entity/batch; provenance recorded via sdk-lineage, audited via sdk-audit.';
