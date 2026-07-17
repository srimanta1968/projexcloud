-- Migration 002: sdk-sequence — reactive control (pause/stop/replace). P14·E1.
-- Auto-applied by the migration runner at boot.
--
-- Ports the outreach sequence-cancellation + reply/booking reactive triggers:
--   - pause-on-reply     -> execution steps move to 'paused' (skipped by the
--                           executor, resumable);
--   - stop-on-optout/pay -> active steps 'canceled' (queued-step cancellation);
--   - replace-CTA        -> upcoming steps' template/body swapped in place.
-- Reason + trigger event are captured on the execution_step row.
--
-- Additive to 001; idempotent (DROP CONSTRAINT IF EXISTS then re-ADD, ADD COLUMN
-- IF NOT EXISTS). Down in ../down/.

-- Add 'paused' to the execution_step status set (the executor's claim query only
-- picks pending/scheduled/deferred, so paused/canceled are naturally skipped).
ALTER TABLE sequence.execution_step DROP CONSTRAINT IF EXISTS execution_step_status_check;
ALTER TABLE sequence.execution_step
  ADD CONSTRAINT execution_step_status_check
  CHECK (status IN ('pending','scheduled','sending','sent','skipped','failed','canceled','deferred','paused'));

-- Reason + trigger-event capture and lifecycle timestamps for reactive control.
ALTER TABLE sequence.execution_step ADD COLUMN IF NOT EXISTS control_reason TEXT;
ALTER TABLE sequence.execution_step ADD COLUMN IF NOT EXISTS control_event  TEXT;
ALTER TABLE sequence.execution_step ADD COLUMN IF NOT EXISTS paused_at      TIMESTAMPTZ;
ALTER TABLE sequence.execution_step ADD COLUMN IF NOT EXISTS canceled_at    TIMESTAMPTZ;

COMMENT ON COLUMN sequence.execution_step.control_reason IS 'Reactive-control reason (e.g. reply / optout / payment); captured on pause/stop.';
COMMENT ON COLUMN sequence.execution_step.control_event  IS 'Reactive-control trigger event that drove pause/stop/replace.';
