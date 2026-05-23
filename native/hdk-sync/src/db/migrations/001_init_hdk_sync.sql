-- Migration 001: hdk-sync server-side schema per P3-Canonical-Privacy-HDK-DataModel §11.2.
-- G6 closer. Auto-applied by @projexlight/migration-runner.
-- Server tables (App Pool): hdk_sync.{replay_log, conflict, human_review_task}.
-- On-device hdk_sync.outbox lives in SQLite, not Postgres.
-- FR-HS-1..7.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS hdk_sync;

-- hdk_sync.event_type_policy — every event type that ships via hdk-sync must
-- have its conflict_policy registered here (AC-13). Producers blocked at the
-- gateway if missing.
CREATE TABLE IF NOT EXISTS hdk_sync.event_type_policy (
  event_type        TEXT PRIMARY KEY,
  conflict_policy   TEXT NOT NULL
                      CHECK (conflict_policy IN ('crdt','lww','merge','event-sourcing','human-review')),
  strategy_detail   TEXT,
  retention_class   TEXT NOT NULL DEFAULT 'operational'
                      CHECK (retention_class IN ('transient','operational','regulated')),
  registered_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- hdk_sync.replay_log — server records of replay batches.
CREATE TABLE IF NOT EXISTS hdk_sync.replay_log (
  batch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid     TEXT NOT NULL,
  -- P3 DataModel §11.2 specifies tenant_id as TEXT (matches PoolFamily routing key shape).
  tenant_id       TEXT NOT NULL,
  event_count     INTEGER NOT NULL DEFAULT 0,
  conflict_count  INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS replay_log_device_idx ON hdk_sync.replay_log (device_uuid, started_at DESC);
CREATE INDEX IF NOT EXISTS replay_log_tenant_idx ON hdk_sync.replay_log (tenant_id, started_at DESC);

-- hdk_sync.conflict — every conflict resolution record (audited).
CREATE TABLE IF NOT EXISTS hdk_sync.conflict (
  conflict_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id               UUID REFERENCES hdk_sync.replay_log(batch_id) ON DELETE CASCADE,
  event_type             TEXT NOT NULL,
  conflict_policy        TEXT NOT NULL
                           CHECK (conflict_policy IN ('crdt','lww','merge','event-sourcing','human-review')),
  strategy_detail        TEXT,
  input_a                JSONB NOT NULL,
  input_b                JSONB NOT NULL,
  resolved               JSONB,
  escalated_to_human     BOOLEAN NOT NULL DEFAULT FALSE,
  audit_entry_id         UUID,
  resolved_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS conflict_batch_idx     ON hdk_sync.conflict (batch_id);
CREATE INDEX IF NOT EXISTS conflict_event_type_idx ON hdk_sync.conflict (event_type, resolved_at DESC);
CREATE INDEX IF NOT EXISTS conflict_escalated_idx ON hdk_sync.conflict (escalated_to_human) WHERE escalated_to_human = TRUE;

-- hdk_sync.human_review_task — items requiring human reconciliation.
CREATE TABLE IF NOT EXISTS hdk_sync.human_review_task (
  task_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_id           UUID NOT NULL REFERENCES hdk_sync.conflict(conflict_id) ON DELETE CASCADE,
  assignee_persona_id   UUID,
  status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open','in-review','resolved','rejected')),
  resolved_value        JSONB,
  resolved_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_status_idx   ON hdk_sync.human_review_task (status, created_at);
CREATE INDEX IF NOT EXISTS review_assignee_idx ON hdk_sync.human_review_task (assignee_persona_id, status)
  WHERE assignee_persona_id IS NOT NULL;

COMMENT ON TABLE hdk_sync.event_type_policy IS 'Per-event-type conflict policy registry. AC-13 / G6.';
COMMENT ON TABLE hdk_sync.replay_log        IS 'Per-batch replay records from devices.';
COMMENT ON TABLE hdk_sync.conflict          IS 'Every conflict resolution decision is logged for audit.';
COMMENT ON TABLE hdk_sync.human_review_task IS 'Human reconciliation queue for sensitive event types.';
