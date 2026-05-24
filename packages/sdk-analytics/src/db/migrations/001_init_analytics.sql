-- Migration 001: sdk-analytics canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §8.
-- Postgres-side: specs + extract registry. Hot rollups live in
-- ClickHouse (existing clickhouse-runtime); cold + cross-pool live
-- in Iceberg (warehouse.* tables, declared logically here).

CREATE SCHEMA IF NOT EXISTS analytics;

-- ---------------------------------------------------------------------------
-- analytics.rollup_spec — definition of a recurring rollup job.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.rollup_spec (
  spec_id              TEXT PRIMARY KEY,
  -- NULL tenant = platform-default spec.
  tenant_id            UUID,
  name                 TEXT NOT NULL,
  grain                TEXT NOT NULL CHECK (grain IN ('hourly','daily','weekly','monthly')),
  dimensions           TEXT[] NOT NULL,
  source_event_types   TEXT[] NOT NULL,
  -- Hot rollups go to clickhouse; cold + cross-pool go to iceberg
  -- (FR-ANL-4 — runtime enforces target_kind='iceberg' for cross-pool).
  target_kind          TEXT NOT NULL CHECK (target_kind IN ('clickhouse','iceberg')),
  active               BOOLEAN NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_rollup_unique UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS analytics_rollup_active_idx ON analytics.rollup_spec (active, target_kind);

-- ---------------------------------------------------------------------------
-- analytics.cohort / analytics.funnel / analytics.kpi — JSON-defined primitives.
-- Results execute against ClickHouse or Iceberg per the spec.target_kind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.cohort (
  cohort_id    TEXT PRIMARY KEY,
  tenant_id    UUID,
  name         TEXT NOT NULL,
  definition   JSONB NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_cohort_unique UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS analytics.funnel (
  funnel_id    TEXT PRIMARY KEY,
  tenant_id    UUID,
  name         TEXT NOT NULL,
  definition   JSONB NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_funnel_unique UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS analytics.kpi (
  kpi_id       TEXT PRIMARY KEY,
  tenant_id    UUID,
  name         TEXT NOT NULL,
  definition   JSONB NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_kpi_unique UNIQUE (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- analytics.extract_to_lakehouse — Iceberg extract job registry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analytics.extract_to_lakehouse (
  extract_id            TEXT PRIMARY KEY,
  tenant_id             UUID,
  -- catalog.namespace.table — e.g. warehouse.usage_daily,
  -- warehouse.encounter_facts, warehouse.persona_cohorts.
  iceberg_table_ref     TEXT NOT NULL,
  partition_strategy    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Required when extract carries PII (consent gate).
  consent_gate_purpose  TEXT,
  last_extracted_at     TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT analytics_extract_unique UNIQUE (tenant_id, iceberg_table_ref)
);

CREATE INDEX IF NOT EXISTS analytics_extract_consent_idx
  ON analytics.extract_to_lakehouse (consent_gate_purpose)
  WHERE consent_gate_purpose IS NOT NULL;

COMMENT ON SCHEMA analytics IS 'sdk-analytics (P6B §5.5). Postgres-side specs/registry only — hot rollups in ClickHouse, cold + cross-pool in Iceberg warehouse.* (G11 partial; full federation P7).';
