-- Migration 003: enforce step idx uniqueness per run.
--
-- The pre-fix signalRun() computed the next idx via
--   COALESCE((SELECT MAX(idx)+1 FROM workflow.step WHERE run_id=$1), 0)
-- inside the INSERT. Two concurrent signals on the same run both observed
-- the same MAX and inserted with the same idx — sequential `signalRun` calls
-- on a fan-in workflow could collide. Adding the UNIQUE constraint makes the
-- second insert fail (instead of silently double-numbering) so the caller
-- can retry.
--
-- We also wrap the signalRun insert in a retry on UNIQUE violation in the
-- TS layer (see runtimeEngine.ts), so the race is now correctly serialized.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'step_run_idx_unique'
       AND conrelid = 'workflow.step'::regclass
  ) THEN
    ALTER TABLE workflow.step
      ADD CONSTRAINT step_run_idx_unique UNIQUE (run_id, idx);
  END IF;
END
$$;
