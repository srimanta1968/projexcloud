-- Migration 002: sdk-connectors — sync dead-letter queue. P15 · E5.
-- Auto-applied by the migration runner at boot.
--
-- The DLQ the connectors manifest already advertises but never implemented.
-- Captures failed connector-sync payloads with attempt count + next_retry_at,
-- mirroring the sdk-webhook.delivery DLQ shape (status pending/…/dlq → here
-- dlq/retrying/resolved). The /api/connectors/dlq/replay endpoint (later task)
-- and the retry/backoff worker read this table.
--
-- Additive to 001; idempotent (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connectors.sync_deadletter (
  deadletter_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  install_id         UUID REFERENCES connectors.install(install_id) ON DELETE CASCADE,
  connector_kind     TEXT NOT NULL,
  sync_kind          TEXT,
  external_ref       TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  error_code         TEXT,
  status             TEXT NOT NULL DEFAULT 'dlq'
                       CHECK (status IN ('dlq','retrying','resolved','discarded')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts       INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 0),
  next_retry_at      TIMESTAMPTZ,
  first_failed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at    TIMESTAMPTZ,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retry/backoff worker hot path: due entries not yet resolved.
CREATE INDEX IF NOT EXISTS connectors_sync_deadletter_retry_idx
  ON connectors.sync_deadletter (status, next_retry_at)
  WHERE status IN ('dlq','retrying');
CREATE INDEX IF NOT EXISTS connectors_sync_deadletter_tenant_idx
  ON connectors.sync_deadletter (tenant_id, connector_kind, status);
CREATE INDEX IF NOT EXISTS connectors_sync_deadletter_install_idx
  ON connectors.sync_deadletter (install_id) WHERE install_id IS NOT NULL;

COMMENT ON TABLE  connectors.sync_deadletter IS 'Sync DLQ (P15·E5). Failed connector-sync payloads + attempts + next_retry_at. Mirrors sdk-webhook.delivery DLQ shape; drained by the retry worker / replay endpoint.';
COMMENT ON COLUMN connectors.sync_deadletter.status IS 'dlq -> retrying -> resolved (or discarded after max_attempts).';
