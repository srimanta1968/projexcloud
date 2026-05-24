-- Migration 001: connector-snowflake canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §11.

CREATE SCHEMA IF NOT EXISTS connector_snowflake;

-- ---------------------------------------------------------------------------
-- connector_snowflake.install — per-tenant OAuth install record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_snowflake.install (
  install_id           TEXT PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  account_url          TEXT NOT NULL,
  -- Vault-wrapped OAuth token (sdk-vault per OC-8).
  oauth_token_envelope BYTEA NOT NULL,
  status               TEXT NOT NULL DEFAULT 'connected'
                         CHECK (status IN ('connected','expired','revoked','error')),
  last_refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conn_snow_install_tenant_account_uq
  ON connector_snowflake.install (tenant_id, account_url);

-- ---------------------------------------------------------------------------
-- connector_snowflake.table_binding — per-table bidirectional binding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_snowflake.table_binding (
  binding_id         TEXT PRIMARY KEY,
  install_id         TEXT NOT NULL REFERENCES connector_snowflake.install(install_id) ON DELETE CASCADE,
  snowflake_table    TEXT NOT NULL,
  iceberg_table_ref  TEXT NOT NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('snow_to_ice','ice_to_snow','bidir')),
  conflict_policy    TEXT NOT NULL DEFAULT 'lww',
  last_synced_at     TIMESTAMPTZ,

  CONSTRAINT conn_snow_binding_unique UNIQUE (install_id, snowflake_table)
);

CREATE INDEX IF NOT EXISTS conn_snow_binding_install_idx ON connector_snowflake.table_binding (install_id);

-- ---------------------------------------------------------------------------
-- connector_snowflake.sync_run — per-sync execution log.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_snowflake.sync_run (
  run_id        TEXT PRIMARY KEY,
  binding_id    TEXT NOT NULL REFERENCES connector_snowflake.table_binding(binding_id) ON DELETE CASCADE,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  rows_pushed   INTEGER NOT NULL DEFAULT 0 CHECK (rows_pushed >= 0),
  rows_pulled   INTEGER NOT NULL DEFAULT 0 CHECK (rows_pulled >= 0),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','completed','failed')),
  error_message TEXT,

  CONSTRAINT conn_snow_sync_completed_after CHECK (
    completed_at IS NULL OR completed_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS conn_snow_sync_binding_idx ON connector_snowflake.sync_run (binding_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conn_snow_sync_status_idx  ON connector_snowflake.sync_run (status, started_at DESC);

-- ---------------------------------------------------------------------------
-- connector_snowflake.query_log — agent query audit (capability-token-gated).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_snowflake.query_log (
  query_id            TEXT PRIMARY KEY,
  install_id          TEXT NOT NULL REFERENCES connector_snowflake.install(install_id) ON DELETE CASCADE,
  agent_run_id        UUID NOT NULL,
  capability_token_id TEXT NOT NULL,
  soql_or_sql         TEXT NOT NULL,
  bytes_scanned       BIGINT NOT NULL DEFAULT 0 CHECK (bytes_scanned >= 0),
  provider_cost       NUMERIC(14,8) NOT NULL DEFAULT 0,
  billed_cost         NUMERIC(14,8) NOT NULL DEFAULT 0,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conn_snow_query_install_idx ON connector_snowflake.query_log (install_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS conn_snow_query_agent_idx   ON connector_snowflake.query_log (agent_run_id);

COMMENT ON SCHEMA connector_snowflake IS 'connector-snowflake (P6B §5.8). OAuth install, bidirectional sync bindings, agent query audit.';
