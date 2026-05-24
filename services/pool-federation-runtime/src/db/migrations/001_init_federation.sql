-- Migration 001: pool-federation-runtime canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §10.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- G10 closer. The schema is the SAME `federation` schema that
-- sdk-analytics extends with iceberg_* tables in P7. CREATE SCHEMA
-- IF NOT EXISTS keeps both migrations independent.

CREATE SCHEMA IF NOT EXISTS federation;

-- ---------------------------------------------------------------------------
-- federation.federation — runtime registry of named federations.
--
-- Relationship to routing.pool_federation_manifest (P1):
--   * The P1 manifest is the source of truth for the tenant→pool_indexes
--     mapping (per-tenant manifest entries, per query_class).
--   * This table layers RUNTIME concerns on top: a stable federation_id,
--     a human-readable name, region affinity, capacity_class for Tier
--     S/P/G isolation (Architecture §12), and activation timestamp.
--   * pool_indexes on this row is the SUPERSET of pools enrolled in
--     this federation; per-(federation, query_class) RESOLVED subsets
--     live in federation.route below.
--   * manifest_id is a logical FK into routing.pool_federation_manifest
--     so admin tools can navigate from a runtime federation back to the
--     P1 hook that authorized it. Logical (not hard) FK to keep this
--     migration independent of the routing schema's load order.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.federation (
  federation_id    TEXT PRIMARY KEY,
  -- Logical FK to routing.pool_federation_manifest.manifest_id.
  manifest_id      UUID,
  region           TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  pool_indexes     TEXT[] NOT NULL DEFAULT '{}',
  capacity_class   TEXT NOT NULL DEFAULT 'standard' CHECK (
    capacity_class IN ('standard','premium','tier-g')
  ),
  activated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_manifest_idx
  ON federation.federation (manifest_id)
  WHERE manifest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS federation_region_idx
  ON federation.federation (region, capacity_class);
CREATE UNIQUE INDEX IF NOT EXISTS federation_region_name_uq
  ON federation.federation (region, name);

-- ---------------------------------------------------------------------------
-- federation.route — resolved cross-pool route per (federation, query_class).
-- The four query_class values match the OC-5 sanctioned cross-pool cases
-- (Architecture §3A): resolver · dsar · analytics · lineage. Cached in
-- Redis under fed:route:{federation_id}:{query_class} TTL 60s.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.route (
  route_id              TEXT PRIMARY KEY,
  federation_id         TEXT NOT NULL REFERENCES federation.federation(federation_id) ON DELETE CASCADE,
  query_class           TEXT NOT NULL CHECK (
    query_class IN ('resolver','dsar','analytics','lineage')
  ),
  target_pool_indexes   TEXT[] NOT NULL DEFAULT '{}',
  execution_plan        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_route_fed_class_uq
  ON federation.route (federation_id, query_class);
CREATE INDEX IF NOT EXISTS federation_route_last_used_idx
  ON federation.route (last_used_at DESC NULLS LAST);

-- ---------------------------------------------------------------------------
-- federation.failover_event — auditable history of every failover (chaos
-- drill, real production failover, operator-initiated). rpo/rto observed
-- in seconds; PRD AC-6 sets the SLO budget.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.failover_event (
  event_id        TEXT PRIMARY KEY,
  federation_id   TEXT NOT NULL REFERENCES federation.federation(federation_id) ON DELETE CASCADE,
  from_region     TEXT NOT NULL,
  to_region       TEXT NOT NULL,
  trigger         TEXT NOT NULL CHECK (
    trigger IN ('chaos-drill','production-failover','operator-initiated')
  ),
  rpo_observed    INTEGER NOT NULL CHECK (rpo_observed >= 0),
  rto_observed    INTEGER NOT NULL CHECK (rto_observed >= 0),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_failover_fed_idx
  ON federation.failover_event (federation_id, occurred_at DESC);

COMMENT ON SCHEMA federation IS 'Pool Federation Runtime (P7 §5.7 · G10) + Iceberg lakehouse extension (P7 §5.8 · G11). Per-region cross-pool routing + auto-failover registry.';
