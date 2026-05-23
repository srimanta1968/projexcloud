-- Migration 001: connector-zoom mirror tables per P5 DataModel §11.2.
-- Auto-applied via api-gateway runMigrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_zoom;

CREATE TABLE IF NOT EXISTS connector_zoom.zoom_meeting (
  mirror_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id       UUID NOT NULL,
  external_id      TEXT NOT NULL,
  canonical_encounter_id UUID,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag   TEXT,
  last_sync_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','deleted-upstream')),
  UNIQUE (install_id, external_id)
);
CREATE INDEX IF NOT EXISTS zoom_meeting_install_idx ON connector_zoom.zoom_meeting (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_zoom.zoom_recording (
  mirror_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id       UUID NOT NULL,
  external_id      TEXT NOT NULL,
  
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag   TEXT,
  last_sync_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','deleted-upstream')),
  UNIQUE (install_id, external_id)
);
CREATE INDEX IF NOT EXISTS zoom_recording_install_idx ON connector_zoom.zoom_recording (install_id, last_sync_at DESC);

COMMENT ON SCHEMA connector_zoom IS 'connector-zoom mirror tables. Common install/cursor/tool_manifest in connectors schema.';
