-- Migration 002: sdk-voice-agent — evaluation runs, the evidence the publish gate reads.
-- VA·E2 (TK-4471). Auto-applied via api-gateway runMigrations.
--
-- A version can only go live after (a) a PASSING evaluation run recorded against it
-- and (b) an approved sdk-approval request whose subject is that version. This table
-- is (a). The simulated-caller harness (VA·E10, TK-4518) records its runs here through
-- POST /api/voice-agent/agents/:agent_id/versions/:version_id/eval-runs; publish reads
-- the most recent run for the version, so a later failing run blocks a re-publish.
--
-- Idempotent (IF NOT EXISTS); down in ../down/.

CREATE TABLE IF NOT EXISTS voice_agent.eval_run (
  eval_run_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  agent_id     UUID NOT NULL REFERENCES voice_agent.agent (agent_id) ON DELETE CASCADE,
  version_id   UUID NOT NULL REFERENCES voice_agent.agent_version (version_id) ON DELETE CASCADE,
  suite        TEXT NOT NULL DEFAULT 'default',
  passed       BOOLEAN NOT NULL,
  score        NUMERIC(5,4) CHECK (score IS NULL OR (score >= 0 AND score <= 1)),
  metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_eval_run_version_idx ON voice_agent.eval_run (version_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_eval_run_tenant_idx  ON voice_agent.eval_run (tenant_id, created_at DESC);

ALTER TABLE voice_agent.eval_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_agent.eval_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON voice_agent.eval_run;
CREATE POLICY tenant_isolation ON voice_agent.eval_run
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE voice_agent.eval_run IS 'Evaluation results per agent version; the newest run for a version must have passed before it can be published.';
