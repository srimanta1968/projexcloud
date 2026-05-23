-- Migration 001: sdk-connectors framework per P5 DataModel §11.1.
-- Auto-applied via api-gateway. Common shape every connector-{kind} extends.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connectors;

-- One install per (tenant, connector_kind). Creds resolved via sdk-secrets.
CREATE TABLE IF NOT EXISTS connectors.install (
  install_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  connector_kind      TEXT NOT NULL,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('pending','active','paused','uninstalled')),
  credential_ref      TEXT,
  vendor_account_id   TEXT,
  installed_by        UUID NOT NULL,
  installed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalled_at      TIMESTAMPTZ,
  UNIQUE (tenant_id, connector_kind)
);

CREATE INDEX IF NOT EXISTS install_tenant_idx ON connectors.install (tenant_id, status);
CREATE INDEX IF NOT EXISTS install_kind_idx   ON connectors.install (connector_kind, status);

-- Per-install CDC / polling cursor state. Each connector defines its own
-- channel naming convention (e.g. salesforce CDC channel, jira webhook offset).
CREATE TABLE IF NOT EXISTS connectors.sync_cursor (
  cursor_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id    UUID NOT NULL REFERENCES connectors.install(install_id) ON DELETE CASCADE,
  channel       TEXT NOT NULL,
  cursor_value  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (install_id, channel)
);

-- P5 connector → P6A agent CapabilityGraph integration.
-- Each connector seeds rows here at install time so agents discover
-- vendor tools (e.g., salesforce.opportunity.update).
CREATE TABLE IF NOT EXISTS connectors.tool_manifest (
  tool_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id           UUID NOT NULL REFERENCES connectors.install(install_id) ON DELETE CASCADE,
  tool_name            TEXT NOT NULL,
  args_schema          JSONB NOT NULL DEFAULT '{}'::jsonb,
  sku_required         TEXT,
  enabled_for_agents   BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (install_id, tool_name)
);

CREATE INDEX IF NOT EXISTS tool_manifest_install_idx ON connectors.tool_manifest (install_id);
CREATE INDEX IF NOT EXISTS tool_manifest_enabled_idx ON connectors.tool_manifest (enabled_for_agents) WHERE enabled_for_agents = TRUE;

COMMENT ON TABLE connectors.install        IS 'One row per (tenant, connector_kind). credential_ref points at sdk-secrets.';
COMMENT ON TABLE connectors.sync_cursor    IS 'Per-channel CDC/polling cursor state, prevents replaying events on restart.';
COMMENT ON TABLE connectors.tool_manifest  IS 'Vendor tool entries surfaced to P6A agent CapabilityGraph.';
