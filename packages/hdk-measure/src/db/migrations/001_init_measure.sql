-- Migration 001: hdk-measure server anchor per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §13.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Lands AFTER sdk-evidence (capture_id FK target) in the migration runner
-- order (services/api-gateway/src/app.ts).

CREATE SCHEMA IF NOT EXISTS hdk_measure;

CREATE TABLE IF NOT EXISTS hdk_measure.measurement (
  measurement_id   TEXT PRIMARY KEY,
  -- Logical FK to evidence.capture; left logical so this package can ship
  -- independently of sdk-evidence (cross-schema hard FK is a footgun for
  -- pool migration).
  capture_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('area','distance','volume')),
  value            NUMERIC NOT NULL,
  unit             TEXT NOT NULL,
  accuracy_class   TEXT NOT NULL DEFAULT 'medium' CHECK (
    accuracy_class IN ('high','medium','low')
  ),
  device_uuid      TEXT NOT NULL,
  captured_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS hdk_measure_capture_idx
  ON hdk_measure.measurement (capture_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS hdk_measure_device_idx
  ON hdk_measure.measurement (device_uuid, captured_at DESC);

COMMENT ON SCHEMA hdk_measure IS 'hdk-measure (P7 §5.9, datamodel §13). Server anchor for AR-based measurements captured on device.';
