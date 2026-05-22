-- ClickHouse rollup schema per P1-Foundation-Spine section 9.3.
-- Raw events partitioned by month and pool_index; MergeTree for events,
-- SummingMergeTree for the hourly daily monthly rollups.

CREATE DATABASE IF NOT EXISTS meter;

CREATE TABLE IF NOT EXISTS meter.usage_event
(
    event_id        String,
    sku             LowCardinality(String),
    units           Decimal128(6),
    org_id          String,
    app_id          LowCardinality(String),
    tenant_id       String,
    bu_id           String,
    persona_id      String,
    encounter_id    String,
    pool_index      LowCardinality(String),
    actor_kind      LowCardinality(String),
    actor_id        String,
    region          LowCardinality(String),
    latency_ms      Int32,
    bytes_in        Int64,
    bytes_out       Int64,
    occurred_at     DateTime64(3, 'UTC'),
    trace_id        String,
    ingested_at     DateTime64(3, 'UTC') DEFAULT now64()
)
ENGINE = MergeTree()
PARTITION BY (toYYYYMM(occurred_at), pool_index)
ORDER BY (tenant_id, sku, occurred_at)
TTL toDateTime(occurred_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS meter.usage_hourly
(
    tenant_id   String,
    sku         LowCardinality(String),
    pool_index  LowCardinality(String),
    hour        DateTime,
    units       SimpleAggregateFunction(sum, Decimal128(6)),
    event_count SimpleAggregateFunction(sum, UInt64)
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, sku, pool_index, hour)
TTL hour + INTERVAL 1 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS meter.usage_hourly_mv
TO meter.usage_hourly AS
SELECT
    tenant_id,
    sku,
    pool_index,
    toStartOfHour(occurred_at) AS hour,
    sum(units) AS units,
    count() AS event_count
FROM meter.usage_event
GROUP BY tenant_id, sku, pool_index, hour;

CREATE TABLE IF NOT EXISTS meter.usage_daily
(
    tenant_id      String,
    sku            LowCardinality(String),
    pool_index     LowCardinality(String),
    bu_id          String,
    persona_id     String,
    day            Date,
    units          SimpleAggregateFunction(sum, Decimal128(6)),
    event_count    SimpleAggregateFunction(sum, UInt64)
)
ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, sku, pool_index, day, bu_id, persona_id)
TTL day + INTERVAL 3 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS meter.usage_daily_mv
TO meter.usage_daily AS
SELECT
    tenant_id,
    sku,
    pool_index,
    bu_id,
    persona_id,
    toDate(occurred_at) AS day,
    sum(units) AS units,
    count() AS event_count
FROM meter.usage_event
GROUP BY tenant_id, sku, pool_index, bu_id, persona_id, day;

CREATE TABLE IF NOT EXISTS meter.usage_monthly
(
    tenant_id      String,
    sku            LowCardinality(String),
    pool_index     LowCardinality(String),
    month          Date,
    units          SimpleAggregateFunction(sum, Decimal128(6)),
    event_count    SimpleAggregateFunction(sum, UInt64)
)
ENGINE = SummingMergeTree()
PARTITION BY toYear(month)
ORDER BY (tenant_id, sku, pool_index, month)
TTL month + INTERVAL 7 YEAR;

CREATE MATERIALIZED VIEW IF NOT EXISTS meter.usage_monthly_mv
TO meter.usage_monthly AS
SELECT
    tenant_id,
    sku,
    pool_index,
    toStartOfMonth(occurred_at) AS month,
    sum(units) AS units,
    count() AS event_count
FROM meter.usage_event
GROUP BY tenant_id, sku, pool_index, month;
