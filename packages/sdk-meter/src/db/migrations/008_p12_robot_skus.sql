-- Migration 008: per-robot / per-sensor metering for the physical-AI fleet
-- (P12 · E1). Forward-only; sha256-tracked. All statements idempotent.
--
-- Adds (1) the P12 SKU rate card (sample defaults — production rates land via
-- the catalog-versioning admin workflow, same caveat as 005_p7_skus.sql), and
-- (2) meter.robot_usage_day: a per-(tenant, asset, sensor, day, sku) usage
-- rollup so usage can be attributed and queried per robot / per sensor without
-- scanning the raw usage-event stream.

-- ---------------------------------------------------------------------------
-- Step 1: P12 pricing catalog + robot/sensor SKUs.
-- ---------------------------------------------------------------------------
INSERT INTO meter.pricing_catalog (catalog_id, version, status, effective_from, created_by)
VALUES ('platform-p12-2026q3', 1, 'active', now(), 'migration:008_p12_robot_skus')
ON CONFLICT (catalog_id) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p12-2026q3', 'robot.sensor.reading', 'reading', 'per_unit',      0.000001),
  ('platform-p12-2026q3', 'robot.command.issue',  'call',    'flat_per_call', 0.001),
  ('platform-p12-2026q3', 'robot.active.hour',     'hour',    'per_unit',      0.05)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 2: per-robot / per-sensor usage rollup.
-- sensor_id uses the all-zero UUID sentinel for asset-level (no-sensor) usage
-- so the natural key stays NOT NULL and upsert has a deterministic conflict
-- target (Postgres UNIQUE treats NULLs as distinct, which breaks ON CONFLICT).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter.robot_usage_day (
  tenant_id  uuid NOT NULL,
  asset_id   uuid NOT NULL,
  sensor_id  uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  day        date NOT NULL,
  sku        text NOT NULL,
  units      double precision NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, asset_id, sensor_id, day, sku)
);
CREATE INDEX IF NOT EXISTS meter_robot_usage_asset_idx ON meter.robot_usage_day (asset_id, day DESC);
CREATE INDEX IF NOT EXISTS meter_robot_usage_tenant_idx ON meter.robot_usage_day (tenant_id, day DESC);
