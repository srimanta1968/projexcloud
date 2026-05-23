-- Migration 001: connector-zendesk mirror tables per P5 DataModel §11.2.
-- Auto-applied via api-gateway runMigrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_zendesk;

CREATE TABLE IF NOT EXISTS connector_zendesk.zendesk_ticket (
  mirror_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id       UUID NOT NULL,
  external_id      TEXT NOT NULL,
  canonical_ticket_id UUID,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_etag   TEXT,
  last_sync_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','deleted-upstream')),
  UNIQUE (install_id, external_id)
);
CREATE INDEX IF NOT EXISTS zendesk_ticket_install_idx ON connector_zendesk.zendesk_ticket (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_zendesk.zendesk_macro (
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
CREATE INDEX IF NOT EXISTS zendesk_macro_install_idx ON connector_zendesk.zendesk_macro (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_zendesk.zendesk_automation (
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
CREATE INDEX IF NOT EXISTS zendesk_automation_install_idx ON connector_zendesk.zendesk_automation (install_id, last_sync_at DESC);

COMMENT ON SCHEMA connector_zendesk IS 'connector-zendesk mirror tables. Common install/cursor/tool_manifest in connectors schema.';
