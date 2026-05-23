-- Migration 001: connector-slack per P4 PRD §5.11.
-- Auto-applied via api-gateway runMigrations. Workspace/channel/message
-- mirrors live in the connector_slack schema; common install/cursor/
-- tool_manifest live in the connectors schema from sdk-connectors.
-- Real Slack HTTP (Web API + Events API + Block Kit interactions) is a
-- separate workstream — this migration ships the storage contract.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_slack;

-- Per-tenant Slack workspace install. slack_team_id is globally unique because
-- a Slack workspace can only be connected to one tenant install at a time.
CREATE TABLE IF NOT EXISTS connector_slack.workspace (
  workspace_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  install_id        UUID NOT NULL,
  slack_team_id     TEXT NOT NULL UNIQUE,
  team_name         TEXT,
  bot_user_id       TEXT,
  scopes            TEXT[],
  access_token_ref  TEXT NOT NULL,
  installed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_tenant_idx  ON connector_slack.workspace (tenant_id);
CREATE INDEX IF NOT EXISTS workspace_install_idx ON connector_slack.workspace (install_id);

CREATE TABLE IF NOT EXISTS connector_slack.channel (
  channel_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES connector_slack.workspace(workspace_id) ON DELETE CASCADE,
  slack_channel_id  TEXT NOT NULL,
  name              TEXT,
  is_private        BOOLEAN NOT NULL DEFAULT FALSE,
  archived          BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (workspace_id, slack_channel_id)
);
CREATE INDEX IF NOT EXISTS channel_workspace_idx ON connector_slack.channel (workspace_id);

-- Outbound message ledger. content_hash lets the dedupe layer block re-posts
-- of the same encounter narrative within a short window.
CREATE TABLE IF NOT EXISTS connector_slack.message_outbound (
  message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES connector_slack.workspace(workspace_id) ON DELETE CASCADE,
  channel_id    UUID NOT NULL REFERENCES connector_slack.channel(channel_id)     ON DELETE CASCADE,
  slack_ts      TEXT,
  encounter_id  UUID,
  content_hash  TEXT,
  posted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by     TEXT
);
CREATE INDEX IF NOT EXISTS message_outbound_workspace_idx ON connector_slack.message_outbound (workspace_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS message_outbound_encounter_idx ON connector_slack.message_outbound (encounter_id) WHERE encounter_id IS NOT NULL;

-- Inbound interactions (slash commands, button clicks, modal submits, generic
-- Events API callbacks). Payload preserved verbatim for replay + audit.
CREATE TABLE IF NOT EXISTS connector_slack.interaction (
  interaction_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES connector_slack.workspace(workspace_id) ON DELETE CASCADE,
  kind            TEXT NOT NULL
                    CHECK (kind IN ('slash-command','button-click','modal-submit','event-callback')),
  payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS interaction_workspace_idx ON connector_slack.interaction (workspace_id, received_at DESC);

-- RLS per P1 doctrine: workspace is the per-tenant root. Downstream tables
-- inherit isolation through their workspace_id FK joins.
ALTER TABLE connector_slack.workspace ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_tenant_isolation ON connector_slack.workspace;
CREATE POLICY workspace_tenant_isolation ON connector_slack.workspace
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON SCHEMA connector_slack IS 'connector-slack mirror tables per P4 §5.11. Common install/cursor/tool_manifest in connectors schema.';
COMMENT ON TABLE connector_slack.workspace        IS 'One row per connected Slack workspace. RLS scoped to app.tenant_id.';
COMMENT ON TABLE connector_slack.channel          IS 'Channel mirror — populated from real channels.list when adapter is configured.';
COMMENT ON TABLE connector_slack.message_outbound IS 'Outbound posts ledger. encounter_id links to engagement.encounter for narrative tracing.';
COMMENT ON TABLE connector_slack.interaction      IS 'Inbound slash/button/modal/event payloads, replay-safe.';
