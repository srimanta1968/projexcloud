-- Migration 001: sdk-sla — business-clock SLA (P16 · EP-376 / PCF-03-1).
--
-- sdk-approval carries a per-step SLA inside an approval; there is no standalone
-- business-hours response clock on the platform, so every vertical hand-rolls
-- one. This is that primitive.
--
--   business_calendar — named IANA working windows, holidays, weekend rule and
--                       the late-coverage extension
--
-- Policies, clocks, ladder rungs and breach records land in migration 002 with
-- the services that own them.
--
-- THE TIMEZONE IS A NAMED IANA ZONE, NEVER A FIXED UTC OFFSET. An offset is a
-- snapshot of a zone on one particular date: store '-05:00' and every clock in
-- that calendar silently drifts by an hour twice a year, in the direction that
-- makes an SLA look met when it was missed. The CHECK below refuses anything
-- shaped like an offset so the mistake cannot be made through a direct INSERT.
--
-- Idempotent + re-runnable; rollback companion in ../down/001_init_sla.down.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS sla;

-- Saturday/Sunday is not universal: much of the Middle East runs Friday/Saturday,
-- and some operations run every day. Naming the rule beats hard-coding day 6 and 0.
DO $$ BEGIN
  CREATE TYPE sla.weekend_rule AS ENUM (
    'saturday_sunday',
    'friday_saturday',
    'sunday_only',
    'friday_only',
    'none'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sla.business_calendar (
  calendar_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  -- A NAMED zone: 'Europe/London', 'America/New_York', 'Asia/Kolkata'.
  timezone     TEXT NOT NULL,
  /*
   * Per-weekday working windows, keyed by ISO weekday number as a string:
   *   { "1": [{"start":"09:00","end":"17:00"}], ..., "5": [...] }
   * An array per day so a split shift (09:00-13:00, 14:00-18:00) is expressible,
   * and a missing or empty day means closed. JSONB rather than a child table
   * because the whole set is read and written together, always by one owner.
   */
  working_windows JSONB NOT NULL DEFAULT '{}'::jsonb,
  /*
   * The late-coverage extension, in minutes past the end of the last window.
   *
   * This is the column that makes the SDK match how response promises actually
   * work: a signal arriving one minute before close is due thirty minutes later
   * INSIDE the extension, not at 09:30 the next morning. Without it, every
   * end-of-day arrival gets a due time that looks generous and reads to the
   * person waiting as being ignored overnight.
   */
  late_coverage_extension_minutes INTEGER NOT NULL DEFAULT 0
    CHECK (late_coverage_extension_minutes >= 0 AND late_coverage_extension_minutes <= 1440),
  weekend_rule sla.weekend_rule NOT NULL DEFAULT 'saturday_sunday',
  -- Dates the calendar is closed regardless of weekday.
  holiday_dates DATE[] NOT NULL DEFAULT ARRAY[]::DATE[],
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug),
  -- Refuse a fixed offset outright: '+05:30', '-0500', 'UTC+2', 'GMT-5'.
  CONSTRAINT business_calendar_named_timezone CHECK (
    timezone ~ '^[A-Za-z][A-Za-z0-9+_-]*(/[A-Za-z0-9+._-]+)+$'
    OR timezone = 'UTC'
  )
);

CREATE INDEX IF NOT EXISTS business_calendar_tenant_idx
  ON sla.business_calendar (tenant_id, is_active);

CREATE OR REPLACE FUNCTION sla.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_calendar_touch_trg ON sla.business_calendar;
CREATE TRIGGER business_calendar_touch_trg
  BEFORE UPDATE ON sla.business_calendar
  FOR EACH ROW EXECUTE FUNCTION sla.touch_updated_at();
