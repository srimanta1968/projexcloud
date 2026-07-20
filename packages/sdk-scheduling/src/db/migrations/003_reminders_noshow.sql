-- Migration 003: sdk-scheduling — timed reminders + no-show marking.
-- P14 · E2 (TK-3621). Auto-applied by the migration runner at boot. Additive +
-- idempotent.
--
-- Adds a scheduling.reminder table (one row per scheduled pre-meeting reminder — the
-- 24h/2h/15m fan-out) that a worker drains, plus no_show/last_reminder bookkeeping on
-- the appointment. No-show detection marks confirmed appointments whose end_time passed
-- by a grace window (default +10m) as 'no_show' so a rescue/rebook can be offered.

ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS no_show_at TIMESTAMPTZ;
ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;

-- ---------------------------------------------------------------- scheduling.reminder
-- A single scheduled reminder for an appointment (e.g. 1440/120/15 minutes before).
-- A worker claims due rows (remind_at <= now, status pending) and fires the notifier.
CREATE TABLE IF NOT EXISTS scheduling.reminder (
  reminder_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  appointment_id  UUID NOT NULL REFERENCES scheduling.appointment(appointment_id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL CHECK (offset_minutes >= 0),
  remind_at       TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','skipped','cancelled')),
  channel         TEXT,
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  sent_at         TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One reminder per (appointment, offset) — re-scheduling the same fan-out is idempotent.
  UNIQUE (appointment_id, offset_minutes)
);

-- Worker hot path: due reminders ordered by remind_at.
CREATE INDEX IF NOT EXISTS scheduling_reminder_due_idx
  ON scheduling.reminder (status, remind_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS scheduling_reminder_appt_idx
  ON scheduling.reminder (tenant_id, appointment_id);

-- No-show scan hot path: confirmed appointments whose end_time has passed and that
-- haven't been marked yet.
CREATE INDEX IF NOT EXISTS scheduling_appointment_noshow_scan_idx
  ON scheduling.appointment (status, end_time) WHERE status = 'confirmed' AND no_show_at IS NULL;

COMMENT ON TABLE scheduling.reminder IS 'Scheduled pre-meeting reminders (24h/2h/15m fan-out). Drained by the scheduling reminder worker.';
COMMENT ON COLUMN scheduling.appointment.no_show_at IS 'Set by the no-show scan when a confirmed appointment passes end_time + grace unattended.';
