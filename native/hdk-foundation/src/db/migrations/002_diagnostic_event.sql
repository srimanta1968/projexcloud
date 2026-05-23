-- Migration 002: persistent hdk-diagnostic event outbox.
-- Prod fix: the 001 in-process Map dropped events on every restart/scale.
-- This table mirrors the hdk_sync.outbox pattern: events land here and a
-- drain worker ships them to the long-term store (ClickHouse / S3 in P7's
-- sdk-diagnostic-telemetry).

CREATE SCHEMA IF NOT EXISTS hdk_diagnostic;

CREATE TABLE IF NOT EXISTS hdk_diagnostic.event (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid   TEXT NOT NULL,
  category      TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  drained_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS hdk_diagnostic_event_undrained_idx
  ON hdk_diagnostic.event (received_at)
  WHERE drained_at IS NULL;

CREATE INDEX IF NOT EXISTS hdk_diagnostic_event_device_idx
  ON hdk_diagnostic.event (device_uuid, occurred_at DESC);

COMMENT ON TABLE hdk_diagnostic.event IS
  'Persistent outbox for hdk-diagnostic capture. P7 sdk-diagnostic-telemetry drains rows whose drained_at IS NULL into ClickHouse.';
