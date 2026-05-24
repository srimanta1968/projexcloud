-- Migration 001: sdk-mcp-bridge canonical schema per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §8.
-- Auto-applied by @projexlight/migration-runner against the Admin pool.
--
-- Tables (consume side): mcp.server_registration, mcp.tool, mcp.tool_invocation.
-- Tables (expose side):  mcp.exposed_server.
-- Capability tokens come from agents.capability_token (logical FK; no cross-
-- package REFERENCES so the packages stay independently deployable).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS mcp;

CREATE TABLE IF NOT EXISTS mcp.server_registration (
  registration_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  display_name           TEXT NOT NULL,
  transport              TEXT NOT NULL CHECK (transport IN ('http','sse','stdio')),
  endpoint_url           TEXT NOT NULL,
  credential_envelope    BYTEA NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','disabled','degraded')),
  allowed_agent_ids      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS server_reg_tenant_idx  ON mcp.server_registration (tenant_id, status);
CREATE INDEX IF NOT EXISTS server_reg_status_idx  ON mcp.server_registration (status);

CREATE TABLE IF NOT EXISTS mcp.tool (
  tool_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id  UUID NOT NULL REFERENCES mcp.server_registration(registration_id) ON DELETE CASCADE,
  tool_name        TEXT NOT NULL,
  args_schema      JSONB NOT NULL,
  opt_out          BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tool_unique_per_server UNIQUE (registration_id, tool_name)
);

CREATE INDEX IF NOT EXISTS tool_reg_idx     ON mcp.tool (registration_id, opt_out);
CREATE INDEX IF NOT EXISTS tool_name_idx    ON mcp.tool (tool_name);

CREATE TABLE IF NOT EXISTS mcp.tool_invocation (
  invocation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_id              UUID NOT NULL REFERENCES mcp.tool(tool_id) ON DELETE RESTRICT,
  agent_run_id         UUID NOT NULL,
  capability_token_id  UUID NOT NULL,
  args_envelope        BYTEA NOT NULL,
  response_envelope    BYTEA,
  external_cost        NUMERIC(18,8),
  outcome              TEXT NOT NULL
                         CHECK (outcome IN ('succeeded','failed','timeout','denied')),
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS tool_inv_tool_idx        ON mcp.tool_invocation (tool_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS tool_inv_agent_run_idx   ON mcp.tool_invocation (agent_run_id, occurred_at);
CREATE INDEX IF NOT EXISTS tool_inv_token_idx       ON mcp.tool_invocation (capability_token_id);
CREATE INDEX IF NOT EXISTS tool_inv_outcome_idx     ON mcp.tool_invocation (outcome, occurred_at DESC);

CREATE TABLE IF NOT EXISTS mcp.exposed_server (
  exposed_server_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  sdk_kind             TEXT NOT NULL,
  exposed_tool_skus    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  /** Logical reference to api_keys.key — sdk-api-keys lives in a separate package. */
  api_key_id           UUID NOT NULL,
  endpoint_path        TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','paused')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT exposed_server_unique_per_tenant UNIQUE (tenant_id, sdk_kind, endpoint_path)
);

CREATE INDEX IF NOT EXISTS exposed_server_tenant_idx  ON mcp.exposed_server (tenant_id, status);
CREATE INDEX IF NOT EXISTS exposed_server_api_key_idx ON mcp.exposed_server (api_key_id);

COMMENT ON SCHEMA mcp IS 'sdk-mcp-bridge canonical schema · P6A §5.4 · consume + expose sides.';
COMMENT ON COLUMN mcp.server_registration.credential_envelope
  IS 'Vault-wrapped bearer/OAuth token; never raw secrets.';
COMMENT ON COLUMN mcp.tool_invocation.capability_token_id
  IS 'Logical reference to agents.capability_token; required by FR-MCP-3.';
