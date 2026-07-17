-- Down for 002_reactive_control. Restores the original status CHECK and drops
-- the reactive-control columns. (The migration runner is forward-only; this is
-- for manual rollback / local resets.)

ALTER TABLE sequence.execution_step DROP CONSTRAINT IF EXISTS execution_step_status_check;
ALTER TABLE sequence.execution_step
  ADD CONSTRAINT execution_step_status_check
  CHECK (status IN ('pending','scheduled','sending','sent','skipped','failed','canceled','deferred'));

ALTER TABLE sequence.execution_step DROP COLUMN IF EXISTS control_reason;
ALTER TABLE sequence.execution_step DROP COLUMN IF EXISTS control_event;
ALTER TABLE sequence.execution_step DROP COLUMN IF EXISTS paused_at;
ALTER TABLE sequence.execution_step DROP COLUMN IF EXISTS canceled_at;
