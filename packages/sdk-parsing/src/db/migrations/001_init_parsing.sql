-- Migration 001: sdk-parsing canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §5.
-- Auto-applied by @projexlight/migration-runner.

CREATE SCHEMA IF NOT EXISTS parsing;

-- ---------------------------------------------------------------------------
-- parsing.job — one row per parse request.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsing.job (
  job_id               TEXT PRIMARY KEY,
  tenant_id            UUID NOT NULL,
  source_blob_id       TEXT NOT NULL,
  document_kind        TEXT NOT NULL,
  taxonomy_version_id  UUID NOT NULL,
  state                TEXT NOT NULL DEFAULT 'queued'
                         CHECK (state IN ('queued','running','needs-review','completed','failed')),
  requested_mode       TEXT NOT NULL DEFAULT 'full-parse'
                         CHECK (requested_mode IN ('full-parse','re-extract','re-validate')),
  requested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at         TIMESTAMPTZ,
  billed_units         NUMERIC(12,4) NOT NULL DEFAULT 0,

  CONSTRAINT parsing_job_completed_after CHECK (
    completed_at IS NULL OR completed_at >= requested_at
  )
);

CREATE INDEX IF NOT EXISTS parsing_job_tenant_idx ON parsing.job (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS parsing_job_state_idx  ON parsing.job (state, requested_at DESC);

-- ---------------------------------------------------------------------------
-- parsing.stage_result — one row per pipeline stage execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsing.stage_result (
  result_id          TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES parsing.job(job_id) ON DELETE CASCADE,
  stage              TEXT NOT NULL
                       CHECK (stage IN ('ingest','ocr','classify','schema-resolve','extract','validate','review','route')),
  status             TEXT NOT NULL
                       CHECK (status IN ('succeeded','failed','skipped')),
  -- Vault-wrapped stage output (PRD §5.2).
  payload_envelope   BYTEA,
  latency_ms         INTEGER NOT NULL CHECK (latency_ms >= 0),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS parsing_stage_job_idx   ON parsing.stage_result (job_id, occurred_at);
CREATE INDEX IF NOT EXISTS parsing_stage_state_idx ON parsing.stage_result (stage, status);

-- ---------------------------------------------------------------------------
-- parsing.extracted_field — per-field extraction with provenance + lineage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsing.extracted_field (
  field_id           TEXT PRIMARY KEY,
  job_id             TEXT NOT NULL REFERENCES parsing.job(job_id) ON DELETE CASCADE,
  field_name         TEXT NOT NULL,
  -- Vault-wrapped if sensitive.
  value_envelope     BYTEA,
  confidence         NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  needs_review       BOOLEAN NOT NULL DEFAULT FALSE,
  -- OCR coordinates / page / span pointing into source.
  provenance_span    JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Anchor into sdk-lineage for the derivation chain.
  lineage_node_id    TEXT
);

CREATE INDEX IF NOT EXISTS parsing_field_job_idx     ON parsing.extracted_field (job_id, field_name);
CREATE INDEX IF NOT EXISTS parsing_field_review_idx  ON parsing.extracted_field (needs_review) WHERE needs_review;
CREATE INDEX IF NOT EXISTS parsing_field_lineage_idx ON parsing.extracted_field (lineage_node_id) WHERE lineage_node_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- parsing.review_task — items routed to humans (composes sdk-approval).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parsing.review_task (
  task_id                  TEXT PRIMARY KEY,
  job_id                   TEXT NOT NULL REFERENCES parsing.job(job_id) ON DELETE CASCADE,
  field_id                 TEXT NOT NULL REFERENCES parsing.extracted_field(field_id) ON DELETE CASCADE,
  assignee_persona_id      UUID,
  status                   TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open','in-review','resolved','rejected')),
  resolved_value_envelope  BYTEA,
  resolved_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS parsing_review_status_idx   ON parsing.review_task (status);
CREATE INDEX IF NOT EXISTS parsing_review_assignee_idx ON parsing.review_task (assignee_persona_id) WHERE assignee_persona_id IS NOT NULL;

COMMENT ON SCHEMA parsing IS 'sdk-parsing (P6B §5.2). 8-stage document pipeline + per-field extraction + human-review queue.';
