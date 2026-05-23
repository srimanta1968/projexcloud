-- Migration 001: connector-jira mirror tables per P5 DataModel §11.2.
-- Auto-applied via api-gateway runMigrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_jira;

CREATE TABLE IF NOT EXISTS connector_jira.jira_issue (
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
CREATE INDEX IF NOT EXISTS jira_issue_install_idx ON connector_jira.jira_issue (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_jira.jira_sprint (
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
CREATE INDEX IF NOT EXISTS jira_sprint_install_idx ON connector_jira.jira_sprint (install_id, last_sync_at DESC);


CREATE TABLE IF NOT EXISTS connector_jira.jira_board (
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
CREATE INDEX IF NOT EXISTS jira_board_install_idx ON connector_jira.jira_board (install_id, last_sync_at DESC);

COMMENT ON SCHEMA connector_jira IS 'connector-jira mirror tables. Common install/cursor/tool_manifest in connectors schema.';
