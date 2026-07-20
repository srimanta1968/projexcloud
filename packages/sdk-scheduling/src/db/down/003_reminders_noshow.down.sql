-- Rollback for 003_reminders_noshow.sql (sdk-scheduling, P14·E2 / TK-3621). Not auto-applied.
DROP TABLE IF EXISTS scheduling.reminder;
ALTER TABLE scheduling.appointment
  DROP COLUMN IF EXISTS no_show_at,
  DROP COLUMN IF EXISTS last_reminder_at;
