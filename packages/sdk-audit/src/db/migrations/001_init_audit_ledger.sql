-- Migration 001: sdk-audit canonical schema per P1-Foundation-Spine-DataModel §7.
-- Auto-applied by @projexlight/migration-runner. Per-pool hash chain + regional
-- rollup hooks + customer-facing export queue.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS audit;

CREATE TABLE IF NOT EXISTS audit.entry (
  entry_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_index       TEXT NOT NULL,
  seq              BIGINT NOT NULL,
  event_type       TEXT NOT NULL,
  occurred_at      TIMESTAMPTZ NOT NULL,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('human','service','agent')),
  actor_id         TEXT NOT NULL,
  tenant_id        UUID,
  org_id           TEXT,
  app_id           TEXT,
  bu_id            TEXT,
  subject_kind     TEXT,
  subject_id       TEXT,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_hash        BYTEA,
  entry_hash       BYTEA NOT NULL,
  retention_class  TEXT NOT NULL DEFAULT 'operational'
                     CHECK (retention_class IN ('transient','operational','regulated')),
  expires_at       TIMESTAMPTZ,
  archived_to_s3   BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (pool_index, seq)
);

CREATE INDEX IF NOT EXISTS entry_tenant_idx  ON audit.entry (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS entry_event_idx   ON audit.entry (event_type);
CREATE INDEX IF NOT EXISTS entry_subject_idx ON audit.entry (subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS entry_expires_idx ON audit.entry (expires_at) WHERE expires_at IS NOT NULL;

-- Append-only: block UPDATE/DELETE at the trigger level
CREATE OR REPLACE FUNCTION audit.entry_no_mutate()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit.entry is append-only; % is forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entry_no_update ON audit.entry;
CREATE TRIGGER entry_no_update BEFORE UPDATE ON audit.entry
  FOR EACH ROW EXECUTE FUNCTION audit.entry_no_mutate();

DROP TRIGGER IF EXISTS entry_no_delete ON audit.entry;
CREATE TRIGGER entry_no_delete BEFORE DELETE ON audit.entry
  FOR EACH ROW EXECUTE FUNCTION audit.entry_no_mutate();

CREATE TABLE IF NOT EXISTS audit.chain_head (
  pool_index        TEXT PRIMARY KEY,
  head_entry_id     UUID REFERENCES audit.entry(entry_id),
  head_seq          BIGINT NOT NULL DEFAULT 0,
  head_hash         BYTEA,
  last_verified_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit.regional_rollup (
  region            TEXT NOT NULL,
  day               DATE NOT NULL,
  pool_heads        JSONB NOT NULL DEFAULT '{}'::jsonb,
  rollup_hash       BYTEA NOT NULL,
  prev_rollup_hash  BYTEA,
  PRIMARY KEY (region, day)
);

CREATE TABLE IF NOT EXISTS audit.export_request (
  request_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  format           TEXT NOT NULL CHECK (format IN ('pdf','jsonl')),
  range_start      TIMESTAMPTZ NOT NULL,
  range_end        TIMESTAMPTZ NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','running','ready','failed')),
  artifact_s3_key  TEXT,
  signature        BYTEA,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (range_end >= range_start)
);

CREATE INDEX IF NOT EXISTS export_request_tenant_idx ON audit.export_request (tenant_id, created_at DESC);

COMMENT ON TABLE audit.entry IS 'Canonical append-only audit entry per P1-Foundation-Spine §7. Per-pool chain via (pool_index, seq).';
COMMENT ON TABLE audit.chain_head IS 'Current chain head per pool. Verify job walks back from here.';
COMMENT ON TABLE audit.regional_rollup IS 'Daily cross-pool rollup for regional attestation.';
COMMENT ON TABLE audit.export_request IS 'Customer-facing self-audit export queue (SOC2/HIPAA).';
