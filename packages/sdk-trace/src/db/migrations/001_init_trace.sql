-- Migration 001: sdk-trace canonical schema (G12 closer) per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §7.
-- Auto-applied by @projexlight/migration-runner.
--
-- Tables: trace.trace (one row per trace_id), trace.span (logical Postgres
-- mirror — production OLAP for trace.span lives in ClickHouse via TK-3320),
-- trace.export (customer self-serve PDF/JSON exports).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS trace;

CREATE TABLE IF NOT EXISTS trace.trace (
  trace_id          TEXT PRIMARY KEY,
  tenant_id         UUID,
  persona_id        UUID,
  started_at        TIMESTAMPTZ NOT NULL,
  completed_at      TIMESTAMPTZ,
  root_span_id      TEXT,
  total_latency_ms  INTEGER,
  error_count       INTEGER NOT NULL DEFAULT 0,
  budget_violations JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trace_completed_after_started CHECK (
    completed_at IS NULL OR completed_at >= started_at
  )
);

CREATE INDEX IF NOT EXISTS trace_tenant_idx     ON trace.trace (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS trace_persona_idx    ON trace.trace (persona_id, started_at DESC);
CREATE INDEX IF NOT EXISTS trace_errors_idx     ON trace.trace (error_count, started_at DESC) WHERE error_count > 0;

-- trace.span — logical Postgres mirror. Production OLAP queries hit
-- ClickHouse (provisioned by TK-3320). Postgres copy supports dev/test
-- + supports the FR-TRC-8 regression-assert endpoint without ClickHouse.
CREATE TABLE IF NOT EXISTS trace.span (
  span_id           TEXT PRIMARY KEY,
  trace_id          TEXT NOT NULL REFERENCES trace.trace(trace_id) ON DELETE CASCADE,
  parent_span_id    TEXT,
  layer             TEXT NOT NULL
                      CHECK (layer IN (
                        'gateway','identity','consent','pool-router','vault','policy',
                        'rebac','meter','sdk-body','tool','agent','lineage'
                      )),
  operation         TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ NOT NULL,
  latency_ms        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'ok'
                      CHECK (status IN ('ok','error','cancelled')),
  attributes        JSONB NOT NULL DEFAULT '{}'::jsonb,
  audit_entry_id    UUID,
  usage_event_id    UUID,
  agent_run_id      UUID,

  CONSTRAINT span_ended_after_started CHECK (ended_at >= started_at),
  CONSTRAINT span_latency_nonneg CHECK (latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS span_trace_idx        ON trace.span (trace_id, started_at);
CREATE INDEX IF NOT EXISTS span_parent_idx       ON trace.span (parent_span_id) WHERE parent_span_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS span_layer_idx        ON trace.span (layer, started_at DESC);
CREATE INDEX IF NOT EXISTS span_agent_run_idx    ON trace.span (agent_run_id) WHERE agent_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS span_audit_idx        ON trace.span (audit_entry_id) WHERE audit_entry_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS trace.export (
  export_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  requestor_persona_id   UUID NOT NULL,
  trace_id               TEXT NOT NULL REFERENCES trace.trace(trace_id) ON DELETE RESTRICT,
  format                 TEXT NOT NULL CHECK (format IN ('pdf','json')),
  artifact_s3_key        TEXT,
  signature              BYTEA,
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ready_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS export_tenant_idx     ON trace.export (tenant_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS export_trace_idx      ON trace.export (trace_id);
CREATE INDEX IF NOT EXISTS export_pending_idx    ON trace.export (requested_at) WHERE ready_at IS NULL;

COMMENT ON SCHEMA trace IS 'sdk-trace canonical schema · P6A §5.3 · G12 closer.';
COMMENT ON TABLE trace.span IS 'Postgres logical mirror; production OLAP queries hit ClickHouse (TK-3320).';
