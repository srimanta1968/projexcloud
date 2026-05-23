-- Migration 001: sdk-geo canonical schema per P3-Canonical-Privacy-HDK-DataModel §8.1.
-- Auto-applied by @projexlight/migration-runner.
-- Tables: geo.{address, address_alias, merge_event}.
-- FR-GEO-1..5.
--
-- PostGIS is preferred but optional. When CREATE EXTENSION postgis succeeds,
-- geo.address.geom is a real geography column. When it doesn't, geom is
-- skipped so the migration still runs on bare Postgres.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS geo;

-- PostGIS is REQUIRED by P3 DataModel §8.1: geo.address.geom must be
-- geography(Point,4326).
--
-- DEPLOYMENT NOTE (managed Postgres on RDS / Cloud SQL / Aurora):
-- CREATE EXTENSION postgis requires the postgis binary to be installed at
-- the cluster level — that's a one-time DBA action with superuser. The
-- app role then needs no privilege beyond USAGE because we use
-- `IF NOT EXISTS`, which is idempotent and a no-op when the extension is
-- already present. The DO block below raises an explicit error message
-- with a remediation hint if the extension is unavailable, so the
-- failure is actionable instead of a cryptic "could not open extension
-- control file" deep in the migration trace.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING
      ERRCODE = 'feature_not_supported',
      MESSAGE = 'sdk-geo requires PostGIS, which is not installed in this Postgres cluster.',
      DETAIL  = SQLERRM,
      HINT    = 'A DBA with superuser must run `CREATE EXTENSION postgis` once at the cluster level. On managed Postgres: RDS → instance parameter group "rds.allowed_extensions" must include "postgis"; Cloud SQL → enable in instance flags; Aurora → enable shared_preload_libraries. After enabling, re-run the api-gateway startup; the migration is idempotent.';
  END;
END $$;

CREATE TABLE IF NOT EXISTS geo.address (
  address_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  street          TEXT NOT NULL,
  city            TEXT NOT NULL,
  region          TEXT,
  postal_code     TEXT,
  country         TEXT NOT NULL,
  lat             NUMERIC(9,6),
  lng             NUMERIC(9,6),
  geo_node_id     UUID,
  provider_refs   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per DataModel §8.1 geom is geography(Point,4326). PostGIS is guaranteed
-- present by the CREATE EXTENSION above.
ALTER TABLE geo.address ADD COLUMN IF NOT EXISTS geom geography(Point,4326);
CREATE INDEX IF NOT EXISTS address_geom_idx ON geo.address USING GIST (geom);

CREATE INDEX IF NOT EXISTS address_country_idx ON geo.address (country, postal_code);
CREATE INDEX IF NOT EXISTS address_geo_node_idx ON geo.address (geo_node_id);

CREATE TABLE IF NOT EXISTS geo.address_alias (
  alias_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id   UUID NOT NULL REFERENCES geo.address(address_id) ON DELETE CASCADE,
  raw_input    TEXT NOT NULL,
  hash         BYTEA NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS alias_address_idx ON geo.address_alias (address_id);

CREATE TABLE IF NOT EXISTS geo.merge_event (
  merge_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  winner_address_id   UUID NOT NULL REFERENCES geo.address(address_id) ON DELETE RESTRICT,
  loser_address_id    UUID NOT NULL REFERENCES geo.address(address_id) ON DELETE RESTRICT,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  operator_id         TEXT,
  CHECK (winner_address_id <> loser_address_id)
);

COMMENT ON TABLE geo.address       IS 'Canonical address registry. Consolidation pattern: one row per unique address.';
COMMENT ON TABLE geo.address_alias IS 'Raw-input variants that resolve to the same canonical address. Hash dedup.';
COMMENT ON TABLE geo.merge_event   IS 'Audit trail when two canonical addresses collapse into one.';
