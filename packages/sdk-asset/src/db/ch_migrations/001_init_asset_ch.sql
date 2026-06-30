-- ClickHouse migration 001: sdk-asset per-sensor time-series (P12 · E1).
-- Companion to the Postgres asset.sensor_reading mirror (002_sensor_reading.sql);
-- ClickHouse holds the high-cardinality, columnar fleet telemetry while Postgres
-- keeps the small dev/local mirror. The ingest/query API is storage-agnostic.
--
-- Cascade: raw 1s readings -> 1m rollup -> 1h rollup. Each tier keeps
-- min/max/avg/last/count as AggregateFunction states (mergeable, exact).
-- Retention per P1 §9.3 ClickHouse policy: raw <=90d, 1m 1y, 1h 3y.
--
-- Idempotent (CREATE ... IF NOT EXISTS). The bootstrapper sha256-tracks applied
-- .ch.sql files via asset.ch_migrations so re-runs are safe and forward-only.

CREATE DATABASE IF NOT EXISTS asset;

-- ---------------------------------------------------------------------------
-- asset.sensor_reading — raw high-cardinality readings (1 row per sample).
-- Partitioned by day; TTL trims raw after 90d (rollups retain the history).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset.sensor_reading
(
  sensor_id    UUID,
  asset_id     UUID,
  tenant_id    UUID,
  component_id Nullable(UUID),
  ts           DateTime64(3, 'UTC'),
  value        Float64,
  unit         LowCardinality(String) DEFAULT '',
  quality      LowCardinality(String) DEFAULT '',
  ingested_at  DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(ts)
ORDER BY (tenant_id, sensor_id, ts)
TTL toDateTime(ts) + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE asset.sensor_reading
  ADD INDEX IF NOT EXISTS sensor_reading_asset_idx asset_id TYPE bloom_filter(0.01) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- asset.sensor_reading_1m — per-minute rollup. AggregatingMergeTree keeps
-- mergeable states so min/max/avg/last/count stay exact across background merges.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset.sensor_reading_1m
(
  bucket    DateTime,
  tenant_id UUID,
  asset_id  UUID,
  sensor_id UUID,
  unit      LowCardinality(String),
  cnt       AggregateFunction(count),
  min_v     AggregateFunction(min, Float64),
  max_v     AggregateFunction(max, Float64),
  avg_v     AggregateFunction(avg, Float64),
  last_v    AggregateFunction(argMax, Float64, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, sensor_id, bucket)
TTL bucket + INTERVAL 1 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS asset.sensor_reading_1m_mv
TO asset.sensor_reading_1m
AS SELECT
  toStartOfMinute(ts) AS bucket,
  tenant_id,
  asset_id,
  sensor_id,
  unit,
  countState()           AS cnt,
  minState(value)        AS min_v,
  maxState(value)        AS max_v,
  avgState(value)        AS avg_v,
  argMaxState(value, ts) AS last_v
FROM asset.sensor_reading
GROUP BY bucket, tenant_id, asset_id, sensor_id, unit;

-- ---------------------------------------------------------------------------
-- asset.sensor_reading_1h — per-hour rollup, cascaded from the 1m tier.
-- Re-merges the 1m partial states with the -MergeState combinator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset.sensor_reading_1h
(
  bucket    DateTime,
  tenant_id UUID,
  asset_id  UUID,
  sensor_id UUID,
  unit      LowCardinality(String),
  cnt       AggregateFunction(count),
  min_v     AggregateFunction(min, Float64),
  max_v     AggregateFunction(max, Float64),
  avg_v     AggregateFunction(avg, Float64),
  last_v    AggregateFunction(argMax, Float64, DateTime64(3, 'UTC'))
)
ENGINE = AggregatingMergeTree
PARTITION BY toYYYYMM(bucket)
ORDER BY (tenant_id, sensor_id, bucket)
TTL bucket + INTERVAL 3 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS asset.sensor_reading_1h_mv
TO asset.sensor_reading_1h
AS SELECT
  toStartOfHour(bucket) AS bucket,
  tenant_id,
  asset_id,
  sensor_id,
  unit,
  countMergeState(cnt)        AS cnt,
  minMergeState(min_v)        AS min_v,
  maxMergeState(max_v)        AS max_v,
  avgMergeState(avg_v)        AS avg_v,
  argMaxMergeState(last_v)    AS last_v
FROM asset.sensor_reading_1m
GROUP BY bucket, tenant_id, asset_id, sensor_id, unit;

-- ---------------------------------------------------------------------------
-- Tracking table for the bootstrapper (sha256 of each applied .ch.sql).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset.ch_migrations
(
  sdk        String,
  filename   String,
  sha256     String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree ORDER BY (sdk, filename);
