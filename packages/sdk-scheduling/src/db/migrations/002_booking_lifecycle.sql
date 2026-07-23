-- Migration 002: sdk-scheduling — booking lifecycle + ICS support.
-- P14 · E2 (TK-3624). Auto-applied by the migration runner at boot. Additive +
-- idempotent (ADD COLUMN IF NOT EXISTS) on the 001 appointment table.
--
-- Adds the columns the booking lifecycle (confirm / reschedule / cancel) and ICS
-- invite generation need: a stable ICS UID + a SEQUENCE that increments on every
-- update (RFC 5545 requires SEQUENCE to advance so calendar clients accept the
-- change), lifecycle timestamps + reasons, and a reschedule back-pointer. Also a
-- booking_event audit table for the lifecycle timeline.

-- Stable per-appointment ICS UID (generated once) + RFC 5545 SEQUENCE counter.
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS ics_uid TEXT;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS ics_sequence INTEGER NOT NULL DEFAULT 0 CHECK (ics_sequence >= 0);
-- Lifecycle timestamps + reasons.
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS reschedule_count INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0);
-- When this row is the product of a reschedule, point at the appointment it came from.
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS rescheduled_from_appointment_id UUID;
-- Confirmation-notification bookkeeping (the email/SMS to both parties).
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;

-- Backfill a stable UID for any pre-existing rows so ICS is deterministic.
UPDATE scheduling.appointment
   SET ics_uid = appointment_id::text || '@projexcloud.scheduling'
 WHERE ics_uid IS NULL;

-- ------------------------------------------------------------- scheduling.booking_event
-- Append-only lifecycle timeline for an appointment (created / confirmed / rescheduled /
-- cancelled / reminded / no_show). Powers the booking history + notification audit.
CREATE TABLE IF NOT EXISTS scheduling.booking_event (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  appointment_id  UUID NOT NULL REFERENCES scheduling.appointment(appointment_id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL
                    CHECK (event_type IN ('created','confirmed','rescheduled','cancelled','reminded','completed','no_show','notified')),
  channel         TEXT,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scheduling_booking_event_appt_idx
  ON scheduling.booking_event (tenant_id, appointment_id, created_at);

COMMENT ON TABLE scheduling.booking_event IS 'Append-only booking lifecycle timeline (parity: booking-notification history). One row per lifecycle transition / notification.';
COMMENT ON COLUMN scheduling.appointment.ics_uid IS 'Stable RFC 5545 UID for the appointment''s ICS invite (generated once).';
COMMENT ON COLUMN scheduling.appointment.ics_sequence IS 'RFC 5545 SEQUENCE — incremented on every reschedule/cancel so calendar clients accept the update.';
