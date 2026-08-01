-- Rollback for 002_reservation_cancellation.sql (sdk-data-credits). NOT auto-applied.
-- The trigger function is left as 002 defined it: 001's version is restored by re-running
-- 001, which is idempotent, and dropping the function here would leave the trigger on the
-- table pointing at nothing.
DROP INDEX IF EXISTS data_credits.reservation_open_v2_idx;
ALTER TABLE data_credits.reservation
  DROP CONSTRAINT IF EXISTS reservation_cancellation_has_a_reason;
ALTER TABLE data_credits.reservation
  DROP CONSTRAINT IF EXISTS reservation_one_ending;
ALTER TABLE data_credits.reservation DROP COLUMN IF EXISTS cancel_reason;
ALTER TABLE data_credits.reservation DROP COLUMN IF EXISTS cancelled_at;
