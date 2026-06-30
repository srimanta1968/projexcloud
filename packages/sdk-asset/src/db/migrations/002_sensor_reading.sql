-- sdk-asset: per-sensor time-series readings.
-- Local/dev uses Postgres; at fleet scale this table is mirrored to ClickHouse
-- (high-cardinality, columnar) with the same (sensor_id, asset_id, ts, value)
-- shape and rollup views — the ingest/query API is storage-agnostic.
-- Additive only.

CREATE TABLE IF NOT EXISTS asset.sensor_reading (
  reading_id  bigserial PRIMARY KEY,
  sensor_id   uuid NOT NULL,
  asset_id    uuid NOT NULL,
  tenant_id   uuid NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  value       double precision,
  quality     text
);
CREATE INDEX IF NOT EXISTS asset_reading_sensor_ts_idx ON asset.sensor_reading (sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS asset_reading_asset_ts_idx  ON asset.sensor_reading (asset_id, ts DESC);
