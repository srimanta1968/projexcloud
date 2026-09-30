-- Migration 014: sdk-voice-agent — evaluation runs become jobs the voice runtime executes.
-- VA·E10 (TK-4517 fake providers, TK-4518 simulated-caller harness). Auto-applied via
-- api-gateway runMigrations.
--
-- Until now a run was only ever REPORTED (POST .../eval-runs with passed/score). A tenant can
-- now START one (POST .../eval-runs/start); it is queued, a voice-runtime worker claims it
-- (lease), plays each scenario as a simulated caller over loopback media, and finishes it.
--
-- mode       reported   — recorded by a caller of POST .../eval-runs (unchanged behaviour)
--            sandbox    — fake media + a scripted agent LLM; free, no keys; NEVER unlocks publish
--            evaluation — fake media, the tenant's real LLM keys and tools; scored against thresholds
-- status     queued -> running -> completed | error   (reported runs are completed at once)
-- passed     NULL until the run completes.
-- scenarios  what was asked for; results: per-scenario outcome; metrics: aggregates.
-- claimed_by / lease_until: the worker holding it; an expired lease is re-claimable.
--
-- Idempotent; down in ../down/.

ALTER TABLE voice_agent.eval_run ALTER COLUMN passed DROP NOT NULL;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'reported';
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS scenarios JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS results JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS requested_by TEXT;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS claimed_by TEXT;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE voice_agent.eval_run ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE voice_agent.eval_run ADD CONSTRAINT eval_run_mode_chk CHECK (mode IN ('reported', 'sandbox', 'evaluation'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE voice_agent.eval_run ADD CONSTRAINT eval_run_status_chk CHECK (status IN ('queued', 'running', 'completed', 'error'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The runtime's claim query: oldest queued (or lease-expired) run first.
CREATE INDEX IF NOT EXISTS voice_eval_run_queue_idx ON voice_agent.eval_run (created_at) WHERE status IN ('queued', 'running');
