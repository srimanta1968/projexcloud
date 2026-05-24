-- ClickHouse migration 001: sdk-diagnostic-telemetry OLAP rollups (FR-DIA-4).
-- Companion to the Postgres tables in 001_init_diagnostic.sql; ClickHouse
-- holds high-volume telemetry; Postgres holds the canonical per-event row.
-- Per P1 §9.3 ClickHouse policy: hot ≤30d, hourly 1y, daily 3y.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Bootstrapper sha256-tracks
-- applied .ch.sql files via diagnostic.ch_migrations so re-runs are safe.

CREATE DATABASE IF NOT EXISTS diagnostic;

-- ---------------------------------------------------------------------------
-- diagnostic.crash — hot store for crash reports. Per-tenant skip index.
-- TTL trims hot data; aggregates flow into the daily rollup below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.crash
(
  crash_id        String,
  device_uuid     String,
  person_id       Nullable(UUID),
  tenant_id       Nullable(UUID),
  app_version     LowCardinality(String),
  os_version      LowCardinality(String),
  occurred_at     DateTime64(3, 'UTC'),
  ingested_at     DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(occurred_at)
ORDER BY (tenant_id, occurred_at, crash_id)
TTL toDateTime(occurred_at) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

ALTER TABLE diagnostic.crash
  ADD INDEX IF NOT EXISTS crash_device_idx device_uuid TYPE bloom_filter(0.01) GRANULARITY 4;

-- ---------------------------------------------------------------------------
-- diagnostic.crash_daily — materialized daily rollup per (tenant, app_version).
-- Backs the ops "is this release crashing?" dashboard.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.crash_daily
(
  day             Date,
  tenant_id       Nullable(UUID),
  app_version     LowCardinality(String),
  os_version      LowCardinality(String),
  crash_count     UInt64
)
ENGINE = SummingMergeTree(crash_count)
PARTITION BY toYYYYMM(day)
ORDER BY (day, tenant_id, app_version, os_version)
TTL day + INTERVAL 3 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS diagnostic.crash_daily_mv
TO diagnostic.crash_daily
AS SELECT
  toDate(occurred_at) AS day,
  tenant_id,
  app_version,
  os_version,
  count() AS crash_count
FROM diagnostic.crash
GROUP BY day, tenant_id, app_version, os_version;

-- ---------------------------------------------------------------------------
-- diagnostic.health_hourly — rolled-up health snapshots.
-- avg battery, share of low-battery devices, share with permission gaps.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.health_snapshot
(
  snapshot_id     String,
  device_uuid     String,
  tenant_id       Nullable(UUID),
  battery_pct     Nullable(Float32),
  wifi_state      LowCardinality(String),
  permissions     String CODEC(ZSTD(3)),
  captured_at     DateTime64(3, 'UTC'),
  ingested_at     DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(captured_at)
ORDER BY (tenant_id, captured_at, device_uuid)
TTL toDateTime(captured_at) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS diagnostic.health_hourly
(
  hour              DateTime,
  tenant_id         Nullable(UUID),
  device_count      UInt64,
  avg_battery_pct   Float32,
  low_battery_count UInt64
)
ENGINE = SummingMergeTree((device_count, low_battery_count))
PARTITION BY toYYYYMM(hour)
ORDER BY (hour, tenant_id)
TTL hour + INTERVAL 1 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS diagnostic.health_hourly_mv
TO diagnostic.health_hourly
AS SELECT
  toStartOfHour(captured_at) AS hour,
  tenant_id,
  uniqExactState(device_uuid) AS device_count,
  avg(battery_pct) AS avg_battery_pct,
  countIf(battery_pct < 0.20) AS low_battery_count
FROM diagnostic.health_snapshot
GROUP BY hour, tenant_id;

-- ---------------------------------------------------------------------------
-- diagnostic.session_replay_event — high-volume, short retention.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.session_replay_event
(
  event_id              String,
  device_uuid           String,
  tenant_id             Nullable(UUID),
  sanitized_event_kind  LowCardinality(String),
  payload               String CODEC(ZSTD(3)),
  occurred_at           DateTime64(3, 'UTC'),
  ingested_at           DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(occurred_at)
ORDER BY (device_uuid, occurred_at)
TTL toDateTime(occurred_at) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- ---------------------------------------------------------------------------
-- Tracking table for the bootstrapper.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.ch_migrations
(
  sdk        String,
  filename   String,
  sha256     String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree ORDER BY (sdk, filename);
