-- Migration 001: connector-github canonical schema per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §9.
-- Auto-applied by @projexlight/migration-runner.
--
-- Mirror tables for GitHub entities (repo, issue, pr, workflow_run) plus a
-- vaulted webhook secret per installation. Webhook signature verification +
-- upsert handlers land with TK-3296's backend code.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_github;

CREATE TABLE IF NOT EXISTS connector_github.installation (
  installation_id        BIGINT PRIMARY KEY,
  tenant_id              UUID NOT NULL,
  account_login          TEXT NOT NULL,
  webhook_secret_envelope BYTEA NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','suspended','removed')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS installation_tenant_idx ON connector_github.installation (tenant_id, status);

CREATE TABLE IF NOT EXISTS connector_github.repo (
  repo_id           BIGINT PRIMARY KEY,
  installation_id   BIGINT NOT NULL REFERENCES connector_github.installation(installation_id) ON DELETE CASCADE,
  full_name         TEXT NOT NULL,
  default_branch    TEXT,
  visibility        TEXT CHECK (visibility IN ('public','private','internal')),
  extension_fields  JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_synced_at    TIMESTAMPTZ,
  CONSTRAINT repo_unique_full_name UNIQUE (installation_id, full_name)
);

CREATE INDEX IF NOT EXISTS repo_installation_idx ON connector_github.repo (installation_id);

CREATE TABLE IF NOT EXISTS connector_github.issue (
  issue_id         BIGINT PRIMARY KEY,
  repo_id          BIGINT NOT NULL REFERENCES connector_github.repo(repo_id) ON DELETE CASCADE,
  number           INTEGER NOT NULL,
  title            TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('open','closed')),
  author_login     TEXT NOT NULL,
  labels           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  extension_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_github  TIMESTAMPTZ NOT NULL,
  updated_at_github  TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT issue_unique_number UNIQUE (repo_id, number)
);

CREATE INDEX IF NOT EXISTS issue_repo_state_idx ON connector_github.issue (repo_id, state, updated_at_github DESC);

CREATE TABLE IF NOT EXISTS connector_github.pr (
  pr_id              BIGINT PRIMARY KEY,
  repo_id            BIGINT NOT NULL REFERENCES connector_github.repo(repo_id) ON DELETE CASCADE,
  number             INTEGER NOT NULL,
  title              TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('open','closed','merged','draft')),
  author_login       TEXT NOT NULL,
  base_ref           TEXT NOT NULL,
  head_ref           TEXT NOT NULL,
  merged_at          TIMESTAMPTZ,
  extension_fields   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_github  TIMESTAMPTZ NOT NULL,
  updated_at_github  TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pr_unique_number UNIQUE (repo_id, number)
);

CREATE INDEX IF NOT EXISTS pr_repo_state_idx ON connector_github.pr (repo_id, state, updated_at_github DESC);
CREATE INDEX IF NOT EXISTS pr_author_idx ON connector_github.pr (author_login);

CREATE TABLE IF NOT EXISTS connector_github.workflow_run (
  workflow_run_id    BIGINT PRIMARY KEY,
  repo_id            BIGINT NOT NULL REFERENCES connector_github.repo(repo_id) ON DELETE CASCADE,
  workflow_name      TEXT NOT NULL,
  status             TEXT NOT NULL,
  conclusion         TEXT,
  head_sha           TEXT NOT NULL,
  run_number         INTEGER NOT NULL,
  extension_fields   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at_github  TIMESTAMPTZ NOT NULL,
  updated_at_github  TIMESTAMPTZ NOT NULL,
  ingested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workflow_run_repo_idx ON connector_github.workflow_run (repo_id, updated_at_github DESC);
CREATE INDEX IF NOT EXISTS workflow_run_conclusion_idx ON connector_github.workflow_run (conclusion) WHERE conclusion IS NOT NULL;

COMMENT ON SCHEMA connector_github IS 'GitHub mirror tables · P6A §5.5. Webhook signature verification in TK-3296 backend.';
COMMENT ON COLUMN connector_github.installation.webhook_secret_envelope
  IS 'Vault-wrapped webhook signing secret used to verify X-Hub-Signature-256.';
