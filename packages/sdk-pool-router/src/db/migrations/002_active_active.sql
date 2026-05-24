-- Migration 002: Active-Active Tier-G+ extension per
-- docs/v3.1/datamodel/P8-Deployment-Variants-DataModel.html §6.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Variant D · Active-Active Tier-G+. Sync replication for audit/payment,
-- async for everything else. Per-tenant home region; paired replicas.
-- RPO <= 5s, RTO <= 60s. Monthly chaos drill; tier downgrade on miss.

CREATE SCHEMA IF NOT EXISTS active_active;

-- ---------------------------------------------------------------------------
-- active_active.profile — per-tenant Active-Active configuration.
-- One-to-one with tenant. Tier-G+ required.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_active.profile (
  profile_id              TEXT PRIMARY KEY,
  tenant_id               UUID NOT NULL UNIQUE,
  tier                    TEXT NOT NULL DEFAULT 'tier-g+' CHECK (tier = 'tier-g+'),
  home_region             TEXT NOT NULL,
  paired_regions          TEXT[] NOT NULL DEFAULT '{}',
  rpo_target_seconds      INTEGER NOT NULL DEFAULT 5 CHECK (rpo_target_seconds > 0),
  rto_target_seconds      INTEGER NOT NULL DEFAULT 60 CHECK (rto_target_seconds > 0),
  contract_addendum_ref   TEXT NOT NULL,
  activated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS aa_profile_home_region_idx
  ON active_active.profile (home_region);

-- ---------------------------------------------------------------------------
-- active_active.replication_stream — per-SDK replication mode per profile.
-- mode='sync' for strict-consistency SDKs (audit, payment); 'async' for
-- the rest; 'single-region' for OLTP that must stay home-region-only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_active.replication_stream (
  stream_id        TEXT PRIMARY KEY,
  profile_id       TEXT NOT NULL REFERENCES active_active.profile(profile_id) ON DELETE CASCADE,
  sdk_kind         TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('sync','async','single-region')),
  lag_seconds_p99  NUMERIC NOT NULL DEFAULT 0 CHECK (lag_seconds_p99 >= 0),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS aa_replication_stream_profile_sdk_uq
  ON active_active.replication_stream (profile_id, sdk_kind);

-- ---------------------------------------------------------------------------
-- active_active.failover_drill — monthly chaos drills.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS active_active.failover_drill (
  drill_id                  TEXT PRIMARY KEY,
  profile_id                TEXT NOT NULL REFERENCES active_active.profile(profile_id) ON DELETE CASCADE,
  from_region               TEXT NOT NULL,
  to_region                 TEXT NOT NULL,
  started_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at                TIMESTAMPTZ,
  rpo_observed_seconds      NUMERIC NOT NULL DEFAULT 0 CHECK (rpo_observed_seconds >= 0),
  rto_observed_seconds      NUMERIC NOT NULL DEFAULT 0 CHECK (rto_observed_seconds >= 0),
  passed                    BOOLEAN NOT NULL DEFAULT FALSE,
  audit_entry_id            TEXT NOT NULL,
  tier_downgrade_triggered  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS aa_drill_profile_idx
  ON active_active.failover_drill (profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS aa_drill_failed_idx
  ON active_active.failover_drill (profile_id, started_at DESC)
  WHERE passed = FALSE;

-- ---------------------------------------------------------------------------
-- Modifications to existing routing.* and federation.* schemas (per §6.2).
-- ADD COLUMN IF NOT EXISTS keeps these idempotent on re-runs.
-- ---------------------------------------------------------------------------
ALTER TABLE routing.tenant_pool_map
  ADD COLUMN IF NOT EXISTS replica_pool_indexes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE routing.tenant_pool_map
  ADD COLUMN IF NOT EXISTS active_active_profile_id TEXT;

CREATE INDEX IF NOT EXISTS tenant_pool_map_aa_profile_idx
  ON routing.tenant_pool_map (active_active_profile_id)
  WHERE active_active_profile_id IS NOT NULL;

ALTER TABLE routing.pool
  ADD COLUMN IF NOT EXISTS replication_role TEXT
    CHECK (replication_role IS NULL OR replication_role IN ('primary','replica','standby'));
ALTER TABLE routing.pool
  ADD COLUMN IF NOT EXISTS replicates_from_pool_index TEXT;

CREATE INDEX IF NOT EXISTS pool_replication_role_idx
  ON routing.pool (replication_role)
  WHERE replication_role IS NOT NULL;

-- federation.failover_event lives in the `federation` schema created by
-- services/pool-federation-runtime (P7). Add the Active-Active drill linkage
-- only when that schema exists — keeps the migration safe when P7
-- federation runtime isn't yet deployed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'federation') THEN
    ALTER TABLE federation.failover_event
      ADD COLUMN IF NOT EXISTS active_active_drill_id TEXT;
    CREATE INDEX IF NOT EXISTS federation_failover_aa_drill_idx
      ON federation.failover_event (active_active_drill_id)
      WHERE active_active_drill_id IS NOT NULL;
  END IF;
END $$;

COMMENT ON SCHEMA active_active IS 'P8 Variant D. Per-tenant Active-Active profile + per-SDK replication stream + monthly chaos drills with tier downgrade on miss.';
