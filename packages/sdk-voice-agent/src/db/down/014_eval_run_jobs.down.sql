-- Rollback for 014_eval_run_jobs.sql (VA·E10, TK-4517/4518). NOT auto-applied. Idempotent.
-- Queued/running/sandbox runs have no meaning without the harness: drop them first.
DELETE FROM voice_agent.eval_run WHERE status <> 'completed' OR passed IS NULL;
DROP INDEX IF EXISTS voice_agent.voice_eval_run_queue_idx;
ALTER TABLE voice_agent.eval_run DROP CONSTRAINT IF EXISTS eval_run_status_chk;
ALTER TABLE voice_agent.eval_run DROP CONSTRAINT IF EXISTS eval_run_mode_chk;
ALTER TABLE voice_agent.eval_run
  DROP COLUMN IF EXISTS finished_at, DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS lease_until,
  DROP COLUMN IF EXISTS claimed_by, DROP COLUMN IF EXISTS requested_by, DROP COLUMN IF EXISTS error,
  DROP COLUMN IF EXISTS results, DROP COLUMN IF EXISTS scenarios, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS mode;
ALTER TABLE voice_agent.eval_run ALTER COLUMN passed SET NOT NULL;
