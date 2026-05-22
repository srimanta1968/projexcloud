-- Migration 001: sdk-vault canonical schema per P1-Foundation-Spine-DataModel §6.
-- Per-pool schema isolation; auto-applied by @projexlight/migration-runner.
--
-- Tables: vault.key (all 7 tiers), vault.key_operation (history),
--         vault.encounter_key_seal (hook for P5 encounter; P1-required).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS vault;

CREATE TABLE IF NOT EXISTS vault.key (
  key_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier           TEXT NOT NULL
                   CHECK (tier IN ('root','app','pool','tenant','person','device','encounter')),
  scope_id       TEXT,
  parent_key_id  UUID REFERENCES vault.key(key_id) ON DELETE RESTRICT,
  kms_ref        TEXT,
  state          TEXT NOT NULL DEFAULT 'issued'
                   CHECK (state IN ('issued','active','rotated','shredded')),
  algorithm      TEXT NOT NULL DEFAULT 'AES-256-GCM'
                   CHECK (algorithm IN ('AES-256-GCM','ChaCha20-Poly1305')),
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at     TIMESTAMPTZ,
  shredded_at    TIMESTAMPTZ,
  tenant_id      UUID,
  region         TEXT NOT NULL,

  CONSTRAINT key_root_no_parent CHECK (tier <> 'root' OR parent_key_id IS NULL),
  CONSTRAINT key_nonroot_parent CHECK (tier = 'root' OR parent_key_id IS NOT NULL),
  CONSTRAINT key_shredded_state CHECK (
    (state = 'shredded' AND shredded_at IS NOT NULL AND kms_ref IS NULL)
    OR state <> 'shredded'
  )
);

CREATE INDEX IF NOT EXISTS key_parent_idx ON vault.key (parent_key_id);
CREATE INDEX IF NOT EXISTS key_tier_idx   ON vault.key (tier, state);
CREATE INDEX IF NOT EXISTS key_tenant_idx ON vault.key (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS key_scope_idx  ON vault.key (tier, scope_id) WHERE scope_id IS NOT NULL;

-- Tier ordering: root(0) < app(1) < pool(2) < tenant(3) < person(4) < device(5) < encounter(6)
CREATE OR REPLACE FUNCTION vault.key_check_parent_tier()
RETURNS TRIGGER AS $$
DECLARE
  tier_rank CONSTANT jsonb := '{"root":0,"app":1,"pool":2,"tenant":3,"person":4,"device":5,"encounter":6}'::jsonb;
  parent_tier TEXT;
BEGIN
  IF NEW.parent_key_id IS NULL THEN RETURN NEW; END IF;
  SELECT tier INTO parent_tier FROM vault.key WHERE key_id = NEW.parent_key_id;
  IF parent_tier IS NULL THEN
    RAISE EXCEPTION 'Parent key % not found', NEW.parent_key_id;
  END IF;
  IF (tier_rank->>parent_tier)::int >= (tier_rank->>NEW.tier)::int THEN
    RAISE EXCEPTION 'Invalid parent tier % for child tier %', parent_tier, NEW.tier;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS key_parent_tier_check ON vault.key;
CREATE TRIGGER key_parent_tier_check
  BEFORE INSERT OR UPDATE OF tier, parent_key_id ON vault.key
  FOR EACH ROW EXECUTE FUNCTION vault.key_check_parent_tier();

CREATE TABLE IF NOT EXISTS vault.key_operation (
  op_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id          UUID NOT NULL REFERENCES vault.key(key_id) ON DELETE RESTRICT,
  op              TEXT NOT NULL
                    CHECK (op IN ('issue','rotate','shred','decrypt','encrypt')),
  operator_kind   TEXT NOT NULL
                    CHECK (operator_kind IN ('human','service','agent')),
  operator_id     TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  audit_entry_id  UUID,
  reason          TEXT
);

CREATE INDEX IF NOT EXISTS key_op_key_idx   ON vault.key_operation (key_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS key_op_audit_idx ON vault.key_operation (audit_entry_id);

CREATE TABLE IF NOT EXISTS vault.encounter_key_seal (
  encounter_id      TEXT PRIMARY KEY,
  encounter_key_id  UUID NOT NULL REFERENCES vault.key(key_id) ON DELETE RESTRICT,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sealed_at         TIMESTAMPTZ,
  retention_policy  TEXT NOT NULL,
  tenant_id         UUID NOT NULL
);

CREATE INDEX IF NOT EXISTS encounter_seal_tenant_idx ON vault.encounter_key_seal (tenant_id);

COMMENT ON TABLE vault.key IS 'Canonical 7-tier envelope key registry per P1-Foundation-Spine §6.';
COMMENT ON COLUMN vault.key.kms_ref IS 'Opaque KMS provider pointer; raw key material never lives in this column.';
COMMENT ON TABLE vault.key_operation IS 'Append-only history of every issue/rotate/shred/encrypt/decrypt.';
COMMENT ON TABLE vault.encounter_key_seal IS 'P1 hook for per-encounter key sealing. encounter_id is a logical reference; the encounter table lands in P5.';
