-- Migration 001: connector-gworkspace mirror tables per P5 DataModel §11.2.
-- Auto-applied via api-gateway runMigrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_gworkspace;

CREATE TABLE IF NOT EXISTS connector_gworkspace.gws_drive_file (
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
CREATE INDEX IF NOT EXISTS gws_drive_file_install_idx ON connector_gworkspace.gws_drive_file (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_gworkspace.gws_calendar_event (
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
CREATE INDEX IF NOT EXISTS gws_calendar_event_install_idx ON connector_gworkspace.gws_calendar_event (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_gworkspace.gws_mail_sent (
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
CREATE INDEX IF NOT EXISTS gws_mail_sent_install_idx ON connector_gworkspace.gws_mail_sent (install_id, last_sync_at DESC);

COMMENT ON SCHEMA connector_gworkspace IS 'connector-gworkspace mirror tables. Common install/cursor/tool_manifest in connectors schema.';
