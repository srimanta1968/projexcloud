-- ClickHouse migration 001: trace.span OLAP table (I-5 / TK-3320).
-- Companion to the Postgres trace.span logical mirror in 001_init_trace.sql.
-- ClickHouse holds the production hot store; Postgres mirror is dev/test +
-- regression-assert. Per P1 §9.3 ClickHouse policy: hot ≤90d, hourly 1y,
-- daily 3y, monthly 7y. Rollup TTL drops + materialized views land later.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Bootstrapper sha256-tracks
-- applied .ch.sql files via `trace.ch_migrations` so re-runs are safe.

CREATE DATABASE IF NOT EXISTS trace;

CREATE TABLE IF NOT EXISTS trace.span
(
  span_id            String,
  trace_id           String,
  parent_span_id     Nullable(String),
  layer              LowCardinality(String),
  operation          String,
  started_at         DateTime64(6, 'UTC'),
  ended_at           DateTime64(6, 'UTC'),
  latency_ms         UInt32,
  status             LowCardinality(String),
  attributes         String CODEC(ZSTD(3)),
  audit_entry_id     Nullable(UUID),
  usage_event_id     Nullable(UUID),
  agent_run_id       Nullable(UUID),
  tenant_id          Nullable(UUID),
  /** Insert-time partition selector; not present in source spans. */
  ingested_at        DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(started_at)
ORDER BY (trace_id, started_at, span_id)
TTL toDateTime(started_at) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

-- Per-tenant skip index — most queries filter by tenant_id.
ALTER TABLE trace.span
  ADD INDEX IF NOT EXISTS span_tenant_idx tenant_id TYPE bloom_filter(0.01) GRANULARITY 4;

ALTER TABLE trace.span
  ADD INDEX IF NOT EXISTS span_layer_idx layer TYPE set(16) GRANULARITY 4;

-- Tracking table for the bootstrapper: which .ch.sql files have been applied.
CREATE TABLE IF NOT EXISTS trace.ch_migrations
(
  sdk        String,
  filename   String,
  sha256     String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (sdk, filename);
