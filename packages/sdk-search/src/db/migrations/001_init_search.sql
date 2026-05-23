-- Migration 001: sdk-search canonical metadata schema per P4-Operational-Billing-DataModel §8.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Postgres-side metadata only — actual documents live in OpenSearch.
-- Tables: search.{index_definition, index_partition, saved_query}.
-- FR-SRC-1..6 per PRD §5.5.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS search;

-- search.index_definition per §8 - one row per (tenant, entity_kind) routable index.
-- opensearch_alias is the read-side alias clients query; underlying physical
-- index name varies per rebuild (alias swap pattern for zero-downtime reindex).
CREATE TABLE IF NOT EXISTS search.index_definition (
  index_def_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  entity_kind       TEXT NOT NULL,
  opensearch_alias  TEXT NOT NULL,
  field_mappings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('building','active','deprecated','deleting')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active definition per (tenant, entity_kind). Allows building/deprecated
-- versions to coexist during alias-swap rebuilds.
CREATE UNIQUE INDEX IF NOT EXISTS idx_def_active_uniq
  ON search.index_definition (tenant_id, entity_kind)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_def_tenant_idx
  ON search.index_definition (tenant_id, entity_kind);

-- search.index_partition per §8 - per-pool sharding map for FR-SRC-3.
-- pool_index FK references @projexlight/sdk-pool-router pool_index table
-- (loose ref because pool_router schema is in a separate SDK).
CREATE TABLE IF NOT EXISTS search.index_partition (
  partition_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  index_def_id      UUID NOT NULL REFERENCES search.index_definition(index_def_id) ON DELETE CASCADE,
  pool_index        INTEGER NOT NULL,
  shard             INTEGER NOT NULL DEFAULT 0,
  last_indexed_at   TIMESTAMPTZ,
  doc_count         BIGINT NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_part_def_pool_shard_uniq
  ON search.index_partition (index_def_id, pool_index, shard);
CREATE INDEX IF NOT EXISTS idx_part_def_idx
  ON search.index_partition (index_def_id);

-- search.saved_query per §8 - per-persona reusable query DSL.
-- ABAC filters are NOT serialized into dsl; they are re-applied at execute-time
-- so a saved query honors the CURRENT scope of whoever runs it (FR-SRC-5 nuance).
CREATE TABLE IF NOT EXISTS search.saved_query (
  query_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  persona_id   UUID NOT NULL,
  name         TEXT NOT NULL,
  dsl          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sq_persona_name_uniq
  ON search.saved_query (tenant_id, persona_id, name);

COMMENT ON TABLE search.index_definition IS 'Per P4-DataModel §8. One active row per (tenant, entity_kind); opensearch_alias enables zero-downtime alias-swap rebuilds.';
COMMENT ON TABLE search.index_partition  IS 'Per FR-SRC-3 per-pool sharding. pool_index loose-refs sdk-pool-router pool_index.';
COMMENT ON TABLE search.saved_query      IS 'Per FR-SRC-5. ABAC filters re-applied at execute-time so saved queries honor caller current scope.';
