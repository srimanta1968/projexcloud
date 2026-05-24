-- Migration 001: sdk-diagnostic-telemetry canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §9.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Pool placement: Admin (Postgres for metadata). High-volume rollups
-- live in ClickHouse (separate bootstrap; see sdk-trace pattern).

CREATE SCHEMA IF NOT EXISTS diagnostic;

-- ---------------------------------------------------------------------------
-- diagnostic.crash — one row per crash report. stack_envelope is the
-- encrypted stack-frame blob (envelope-encrypted via sdk-vault per P13).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.crash (
  crash_id        TEXT PRIMARY KEY,
  -- Logical FK to device.device.
  device_uuid     TEXT NOT NULL,
  person_id       UUID,
  app_version     TEXT NOT NULL,
  os_version      TEXT NOT NULL,
  stack_envelope  BYTEA NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS diagnostic_crash_device_idx
  ON diagnostic.crash (device_uuid, occurred_at DESC);
CREATE INDEX IF NOT EXISTS diagnostic_crash_app_version_idx
  ON diagnostic.crash (app_version, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- diagnostic.health_snapshot — periodic device health probe. LWW per device
-- (latest snapshot wins) — but we keep history for trend analysis.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.health_snapshot (
  snapshot_id   TEXT PRIMARY KEY,
  device_uuid   TEXT NOT NULL,
  permissions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  battery_pct   NUMERIC,
  wifi_state    TEXT,
  sensor_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  captured_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS diagnostic_health_device_idx
  ON diagnostic.health_snapshot (device_uuid, captured_at DESC);

-- ---------------------------------------------------------------------------
-- diagnostic.session_replay_event — sanitized event stream. PII stripped at
-- the HDK layer; this table only receives sanitized_event_kind + payload.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS diagnostic.session_replay_event (
  event_id              TEXT PRIMARY KEY,
  device_uuid           TEXT NOT NULL,
  sanitized_event_kind  TEXT NOT NULL,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at           TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS diagnostic_session_replay_device_idx
  ON diagnostic.session_replay_event (device_uuid, occurred_at DESC);

COMMENT ON SCHEMA diagnostic IS 'sdk-diagnostic-telemetry (P7 §5.6). Crashes + health snapshots + session replay (sanitized).';
