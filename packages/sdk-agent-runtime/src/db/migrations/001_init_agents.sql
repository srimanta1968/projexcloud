-- Migration 001: sdk-agent-runtime canonical schema per
-- docs/v3.1/datamodel/P6A-AI-Isolation-MCP-DataModel.html §6.
-- Auto-applied by @projexlight/migration-runner against the Admin pool.
--
-- Closes Gate G7 (Agent Isolation Runtime). Tables encode the four
-- isolation primitives:
--   * Capability tokens — signed, scope-limited, single-use
--   * Execution TTL     — hard deadlines per run
--   * Deterministic replay — content-addressed execution log
--   * Sandboxed memory  — physical per-tenant vector namespaces

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS agents;

-- ---------------------------------------------------------------------------
-- agents.agent_definition
-- ---------------------------------------------------------------------------
-- One row per logical agent. tenant_id NULL means a platform agent
-- (Cost & Safety Steward, etc). tool_manifest is the SKU allow-list the
-- meter enforces at admission time (FR-ART-21..23).
CREATE TABLE IF NOT EXISTS agents.agent_definition (
  agent_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID,
  name                  TEXT NOT NULL,
  description           TEXT,
  acting_persona_id     UUID NOT NULL,
  agent_scope           JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_ttl_seconds   INTEGER NOT NULL DEFAULT 300
                          CHECK (default_ttl_seconds > 0 AND default_ttl_seconds <= 3600),
  tier                  TEXT NOT NULL
                          CHECK (tier IN ('sync','orchestration','batch')),
  kill_switch_flag_id   UUID,
  vector_namespace      TEXT NOT NULL,
  tool_manifest         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_definition_tenant_idx
  ON agents.agent_definition (tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_definition_persona_idx
  ON agents.agent_definition (acting_persona_id);
CREATE INDEX IF NOT EXISTS agent_definition_namespace_idx
  ON agents.agent_definition (vector_namespace);

-- ---------------------------------------------------------------------------
-- agents.vector_namespace_registry
-- ---------------------------------------------------------------------------
-- Hard physical partition per tenant. PRIMARY KEY (namespace) guarantees
-- a namespace is owned by exactly one tenant_id. The additional
-- UNIQUE (tenant_id) constraint honours AC-6 by enforcing that each
-- tenant claims exactly one namespace (defence-in-depth against
-- accidental cross-tenant data placement). FR-ART-13..16.
CREATE TABLE IF NOT EXISTS agents.vector_namespace_registry (
  namespace             TEXT PRIMARY KEY,
  tenant_id             UUID NOT NULL,
  backend               TEXT NOT NULL
                          CHECK (backend IN ('pgvector','pinecone','qdrant','weaviate')),
  connection_envelope   BYTEA NOT NULL,
  verified_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vector_namespace_tenant_uniq UNIQUE (tenant_id)
);

CREATE INDEX IF NOT EXISTS vector_namespace_tenant_idx
  ON agents.vector_namespace_registry (tenant_id);

-- ---------------------------------------------------------------------------
-- agents.agent_run
-- ---------------------------------------------------------------------------
-- One execution. agent_chain is the materialised provenance array (human ->
-- meta-agent -> executing agent) populated at run start (FR-ART-17..18).
-- status terminal values cover the kill-switch / TTL / quota paths.
CREATE TABLE IF NOT EXISTS agents.agent_run (
  run_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id              UUID NOT NULL REFERENCES agents.agent_definition(agent_id) ON DELETE RESTRICT,
  tenant_id             UUID,
  persona_id            UUID NOT NULL,
  trace_id              TEXT NOT NULL,
  parent_run_id         UUID REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  agent_chain           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status                TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN (
                            'running','completed','failed',
                            'terminated_ttl_expired','terminated_kill_switch','terminated_quota'
                          )),
  ttl_deadline          TIMESTAMPTZ NOT NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at              TIMESTAMPTZ,
  tokens_total          INTEGER NOT NULL DEFAULT 0,
  cost_total            NUMERIC(18,8) NOT NULL DEFAULT 0,
  execution_log_ref     TEXT,
  final_output_envelope BYTEA,

  CONSTRAINT agent_run_ttl_after_start CHECK (ttl_deadline > started_at),
  CONSTRAINT agent_run_ended_after_started CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT agent_run_terminal_has_ended CHECK (
    status = 'running' OR ended_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS agent_run_agent_idx    ON agents.agent_run (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_run_tenant_idx   ON agents.agent_run (tenant_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_run_trace_idx    ON agents.agent_run (trace_id);
CREATE INDEX IF NOT EXISTS agent_run_persona_idx  ON agents.agent_run (persona_id);
CREATE INDEX IF NOT EXISTS agent_run_parent_idx   ON agents.agent_run (parent_run_id);
CREATE INDEX IF NOT EXISTS agent_run_ttl_due_idx
  ON agents.agent_run (ttl_deadline) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- agents.capability_token
-- ---------------------------------------------------------------------------
-- Signed, scope-limited, single-use. args_hash binds the token to the exact
-- argument payload (replay-with-different-args is rejected). The companion
-- used_by_invocation_id is a logical reference (no FK) because
-- tool_invocation references this table — a hard FK would create a cycle.
-- FR-ART-1..4.
CREATE TABLE IF NOT EXISTS agents.capability_token (
  token_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  agent_id              UUID NOT NULL REFERENCES agents.agent_definition(agent_id) ON DELETE RESTRICT,
  acting_persona_id     UUID NOT NULL,
  tool_sku              TEXT NOT NULL,
  args_hash             BYTEA NOT NULL,
  tenant_scope          TEXT NOT NULL,
  issued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at            TIMESTAMPTZ NOT NULL,
  used_at               TIMESTAMPTZ,
  used_by_invocation_id UUID,
  revoked_at            TIMESTAMPTZ,
  revoked_reason        TEXT,
  signature_envelope    BYTEA NOT NULL,

  CONSTRAINT capability_token_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT capability_token_revoked_reason CHECK (
    revoked_at IS NULL OR revoked_reason IS NOT NULL
  )
);

-- Composite index supports the hot-path validator lookup:
-- "is this token valid right now?" — filters by (expires_at, used_at, revoked_at).
CREATE INDEX IF NOT EXISTS capability_token_validity_idx
  ON agents.capability_token (token_id, expires_at, used_at, revoked_at);
CREATE INDEX IF NOT EXISTS capability_token_run_idx
  ON agents.capability_token (run_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS capability_token_sku_idx
  ON agents.capability_token (tool_sku, tenant_scope);

-- ---------------------------------------------------------------------------
-- agents.tool_invocation
-- ---------------------------------------------------------------------------
-- One row per tool call. capability_token_id is required (no tool runs
-- without a token, FR-ART-3). compensation_step_id points at the workflow
-- compensable-step record so TTL-expiry rollback knows what to undo.
CREATE TABLE IF NOT EXISTS agents.tool_invocation (
  invocation_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  tool_sku              TEXT NOT NULL,
  capability_token_id   UUID NOT NULL REFERENCES agents.capability_token(token_id) ON DELETE RESTRICT,
  args_envelope         BYTEA NOT NULL,
  result_envelope       BYTEA,
  compensation_step_id  UUID,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms            INTEGER,
  outcome               TEXT NOT NULL
                          CHECK (outcome IN ('succeeded','failed','cancelled','denied'))
);

CREATE INDEX IF NOT EXISTS tool_invocation_run_idx
  ON agents.tool_invocation (run_id, occurred_at);
CREATE INDEX IF NOT EXISTS tool_invocation_token_idx
  ON agents.tool_invocation (capability_token_id);
CREATE INDEX IF NOT EXISTS tool_invocation_sku_idx
  ON agents.tool_invocation (tool_sku, outcome);

-- ---------------------------------------------------------------------------
-- agents.execution_log_entry
-- ---------------------------------------------------------------------------
-- Append-only, content-addressed replay log. seq is the monotonic ordering
-- per run; (run_id, seq) is the natural composite key but we keep entry_id
-- as the surrogate. payload_envelope is vault-wrapped and includes the
-- model snapshot ID so replay can detect drift. FR-ART-8..12.
CREATE TABLE IF NOT EXISTS agents.execution_log_entry (
  entry_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  seq                   INTEGER NOT NULL,
  kind                  TEXT NOT NULL
                          CHECK (kind IN (
                            'prompt-template','context-retrieval','model-invocation',
                            'tool-call','tool-response','final-action',
                            'ttl-event','kill-event'
                          )),
  content_hash          BYTEA NOT NULL,
  payload_envelope      BYTEA NOT NULL,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT execution_log_seq_positive CHECK (seq >= 0),
  CONSTRAINT execution_log_run_seq_uniq UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS execution_log_run_seq_idx
  ON agents.execution_log_entry (run_id, seq);
CREATE INDEX IF NOT EXISTS execution_log_kind_idx
  ON agents.execution_log_entry (run_id, kind);

-- ---------------------------------------------------------------------------
-- agents.scope_exception
-- ---------------------------------------------------------------------------
-- Recorded when an agent attempts an out-of-manifest SKU (FR-ART-23, AC-7,
-- AC-9). approval_request_id points at the sdk-approval queue entry that
-- routes the human sign-off.
CREATE TABLE IF NOT EXISTS agents.scope_exception (
  exception_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  requested_sku         TEXT NOT NULL,
  approval_request_id   UUID,
  outcome               TEXT NOT NULL DEFAULT 'pending'
                          CHECK (outcome IN ('pending','approved','denied','timed-out')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at           TIMESTAMPTZ,

  CONSTRAINT scope_exception_terminal_resolved CHECK (
    outcome = 'pending' OR resolved_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS scope_exception_run_idx
  ON agents.scope_exception (run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scope_exception_outcome_idx
  ON agents.scope_exception (outcome, created_at DESC);

-- ---------------------------------------------------------------------------
-- Table comments — keep canonical doc references with the schema so ops
-- can trace back from a live DB to the PRD section that owns the design.
-- ---------------------------------------------------------------------------
COMMENT ON SCHEMA agents IS 'sdk-agent-runtime canonical schema · P6A · G7 closer.';
COMMENT ON TABLE  agents.agent_definition          IS 'P6A §5.2 · per-agent identity, scope, TTL caps, tool manifest, kill-switch flag.';
COMMENT ON TABLE  agents.agent_run                 IS 'P6A §5.2 · one execution; ttl_deadline enforced by the runtime worker.';
COMMENT ON TABLE  agents.capability_token          IS 'P6A §5.2 Primitive 1 · signed, scope-limited, single-use tool tokens.';
COMMENT ON TABLE  agents.tool_invocation           IS 'P6A §5.2 · one tool call per row; capability_token_id is mandatory.';
COMMENT ON TABLE  agents.execution_log_entry       IS 'P6A §5.2 Primitive 3 · deterministic-replay artifacts (NOT telemetry).';
COMMENT ON TABLE  agents.vector_namespace_registry IS 'P6A §5.2 Primitive 4 · per-tenant memory partitions; boot refuses cross-tenant rows.';
COMMENT ON TABLE  agents.scope_exception           IS 'P6A §5.2 · beyond-scope routing through sdk-approval.';
