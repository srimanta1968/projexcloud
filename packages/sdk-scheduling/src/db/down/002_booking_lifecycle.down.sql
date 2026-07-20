-- Rollback for 002_booking_lifecycle.sql (sdk-scheduling, P14·E2 / TK-3624).
-- NOT auto-applied — the runner is forward-only.
DROP TABLE IF EXISTS scheduling.booking_event;
ALTER TABLE scheduling.appointment
  DROP COLUMN IF EXISTS ics_uid,
  DROP COLUMN IF EXISTS ics_sequence,
  DROP COLUMN IF EXISTS confirmed_at,
  DROP COLUMN IF EXISTS cancelled_at,
  DROP COLUMN IF EXISTS cancel_reason,
  DROP COLUMN IF EXISTS rescheduled_at,
  DROP COLUMN IF EXISTS reschedule_count,
  DROP COLUMN IF EXISTS rescheduled_from_appointment_id,
  DROP COLUMN IF EXISTS confirmation_sent_at;
