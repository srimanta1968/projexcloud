-- Migration 002: idempotency keys for agent_run and tool_invocation (S-5).
-- Per build plan §wave-6 sdk-agent-runtime "idempotence helpers".
--
-- Adds Idempotency-Key support so a client retry within the retention window
-- returns the original run / invocation row rather than creating a duplicate.
-- Scope per row:
--   * agent_run.idempotency_key      UNIQUE per (tenant_id, idempotency_key)
--   * tool_invocation.idempotency_key UNIQUE per (run_id, idempotency_key)
--
-- Forward-only; migration-runner sha256-tracks this file. Idempotent DDL.

ALTER TABLE agents.agent_run
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE agents.tool_invocation
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

-- Partial unique index — only enforce uniqueness when the key is present
-- (most legacy rows will be NULL). Tenant-scoped so two tenants never collide.
CREATE UNIQUE INDEX IF NOT EXISTS agent_run_idem_key_uniq
  ON agents.agent_run (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Per-run scope for tool invocations: same key within the same run returns
-- the existing invocation; different runs may legitimately reuse a key.
CREATE UNIQUE INDEX IF NOT EXISTS tool_invocation_idem_key_uniq
  ON agents.tool_invocation (run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Lookup index for the hot-path "have I seen this key?" check. The unique
-- indexes above can also serve this query, but a non-partial covering index
-- is faster when most rows have non-null keys (steady-state production).
CREATE INDEX IF NOT EXISTS agent_run_idem_lookup_idx
  ON agents.agent_run (idempotency_key, started_at DESC)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN agents.agent_run.idempotency_key
  IS 'S-5 · Client-supplied Idempotency-Key header. Retry within retention returns the original run.';
COMMENT ON COLUMN agents.tool_invocation.idempotency_key
  IS 'S-5 · Per-run idempotency key. Retry within retention returns the original invocation.';
