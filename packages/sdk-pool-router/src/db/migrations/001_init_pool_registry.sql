-- Migration 001: sdk-pool-router canonical schema per P1-Foundation-Spine §8.
-- Auto-applied by @projexlight/migration-runner. Tables: routing.pool,
-- routing.tenant_pool_map, routing.pool_lifecycle_event, routing.pool_federation_manifest.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS routing;

CREATE TABLE IF NOT EXISTS routing.pool (
  pool_index         TEXT PRIMARY KEY,
  pool_family        TEXT NOT NULL
                       CHECK (pool_family IN ('admin','app','evidence','warehouse','vector')),
  app_id             TEXT,
  region             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'ACTIVE'
                       CHECK (status IN ('ACTIVE','MIGRATING','DRAINING','MAINTENANCE','RETIRED','QUARANTINE')),
  capacity_tenants   INTEGER NOT NULL DEFAULT 0,
  current_tenants    INTEGER NOT NULL DEFAULT 0,
  capacity_bytes     BIGINT NOT NULL DEFAULT 0,
  current_bytes      BIGINT NOT NULL DEFAULT 0,
  primary_endpoint   TEXT NOT NULL,
  replica_endpoints  TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  kek_arn            TEXT,
  isolation_class    TEXT NOT NULL DEFAULT 'shared'
                       CHECK (isolation_class IN ('shared','dedicated')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (pool_family <> 'app' OR app_id IS NOT NULL),
  CHECK (pool_family = 'app' OR app_id IS NULL)
);

CREATE INDEX IF NOT EXISTS pool_region_idx ON routing.pool (region, status);
CREATE INDEX IF NOT EXISTS pool_family_idx ON routing.pool (pool_family, status);

CREATE TABLE IF NOT EXISTS routing.tenant_pool_map (
  tenant_id            UUID PRIMARY KEY,
  admin_pool_index     TEXT NOT NULL REFERENCES routing.pool(pool_index) ON DELETE RESTRICT,
  evidence_pool_index  TEXT REFERENCES routing.pool(pool_index) ON DELETE RESTRICT,
  app_pool_index       JSONB NOT NULL DEFAULT '{}'::jsonb,
  region               TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('ACTIVE','MIGRATING','QUARANTINED')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  migrated_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS map_admin_pool_idx    ON routing.tenant_pool_map (admin_pool_index);
CREATE INDEX IF NOT EXISTS map_evidence_pool_idx ON routing.tenant_pool_map (evidence_pool_index);
CREATE INDEX IF NOT EXISTS map_region_idx        ON routing.tenant_pool_map (region, status);

CREATE TABLE IF NOT EXISTS routing.pool_lifecycle_event (
  event_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_index   TEXT NOT NULL REFERENCES routing.pool(pool_index) ON DELETE RESTRICT,
  from_status  TEXT NOT NULL,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_id  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS lifecycle_pool_idx ON routing.pool_lifecycle_event (pool_index, occurred_at DESC);

CREATE TABLE IF NOT EXISTS routing.pool_federation_manifest (
  manifest_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  pool_indexes  TEXT[] NOT NULL,
  query_class   TEXT NOT NULL
                  CHECK (query_class IN ('resolver','dsar','analytics','lineage')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_tenant_idx ON routing.pool_federation_manifest (tenant_id);

CREATE OR REPLACE FUNCTION routing.pool_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pool_touch ON routing.pool;
CREATE TRIGGER pool_touch BEFORE UPDATE ON routing.pool
  FOR EACH ROW EXECUTE FUNCTION routing.pool_touch_updated_at();

COMMENT ON TABLE routing.pool IS 'Pool Registry per P1-Foundation-Spine §8.1. pool_index is the stable identifier.';
COMMENT ON TABLE routing.tenant_pool_map IS 'Per-tenant pool assignment. app_pool_index is a jsonb map of app_id->pool_index.';
COMMENT ON TABLE routing.pool_lifecycle_event IS 'Append-only history of pool state transitions; replayed for cache invalidation.';
COMMENT ON TABLE routing.pool_federation_manifest IS 'Federation hooks shipped in P1; runtime delivered P7.';
