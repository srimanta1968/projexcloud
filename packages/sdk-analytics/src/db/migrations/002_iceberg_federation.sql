-- Migration 002: sdk-analytics Iceberg lakehouse federation extension
-- per docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §11.
-- G11 closer. Lives in the `federation` schema created by either
-- pool-federation-runtime (§10) or this migration (whichever runs first).
-- Auto-applied by @projexlight/migration-runner.

CREATE SCHEMA IF NOT EXISTS federation;

-- ---------------------------------------------------------------------------
-- federation.iceberg_catalog — one row per Iceberg catalog (per region).
-- backend chooses between Glue, Nessie, Hive.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.iceberg_catalog (
  catalog_id      TEXT PRIMARY KEY,
  region          TEXT NOT NULL,
  backend         TEXT NOT NULL CHECK (backend IN ('glue','nessie','hive')),
  root_url        TEXT NOT NULL,
  capacity_tier   TEXT NOT NULL DEFAULT 'standard',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active','degraded','retired')
  ),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_iceberg_catalog_region_backend_uq
  ON federation.iceberg_catalog (region, backend);

-- ---------------------------------------------------------------------------
-- federation.iceberg_table_binding — Iceberg table mapped from a ClickHouse
-- source. partition_strategy + z_order_cols match PRD §5.8 partition spec
-- (region, tenant, time) with Z-order on common predicates.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.iceberg_table_binding (
  binding_id              TEXT PRIMARY KEY,
  catalog_id              TEXT NOT NULL REFERENCES federation.iceberg_catalog(catalog_id) ON DELETE CASCADE,
  table_ref               TEXT NOT NULL,
  source_clickhouse_table TEXT,
  partition_strategy      JSONB NOT NULL DEFAULT '{}'::jsonb,
  z_order_cols            TEXT[] NOT NULL DEFAULT '{}',
  last_compacted_at       TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS federation_iceberg_binding_table_uq
  ON federation.iceberg_table_binding (catalog_id, table_ref);

-- ---------------------------------------------------------------------------
-- federation.lakehouse_query_log — cross-pool query trail with bytes
-- scanned + cost (R-4: per-tenant query budgets need this).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS federation.lakehouse_query_log (
  query_id        TEXT PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  -- Logical FK to agents.agent_run for capability-token attribution.
  agent_run_id    UUID,
  sql_text        TEXT NOT NULL,
  bytes_scanned   BIGINT NOT NULL CHECK (bytes_scanned >= 0),
  cost            NUMERIC NOT NULL DEFAULT 0,
  trace_id        TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS federation_lakehouse_query_log_tenant_idx
  ON federation.lakehouse_query_log (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS federation_lakehouse_query_log_trace_idx
  ON federation.lakehouse_query_log (trace_id);

COMMENT ON TABLE federation.iceberg_catalog       IS 'P7 G11 — per-region Iceberg catalog (Glue/Nessie/Hive).';
COMMENT ON TABLE federation.iceberg_table_binding IS 'P7 G11 — Iceberg table bound to source ClickHouse table; partition + Z-order strategy.';
COMMENT ON TABLE federation.lakehouse_query_log   IS 'P7 G11 — cross-pool Iceberg query log with cost attribution.';
