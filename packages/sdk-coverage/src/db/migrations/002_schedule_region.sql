-- Migration 002: sdk-coverage — which region's holidays apply to a persona
-- (P16 · EP-377 · PCF-04-2).
--
-- holiday_calendar is scoped by tenant AND region, but 001 gave a schedule no way
-- to say WHICH region it follows. Without that the eligibility engine can only
-- apply holidays tenant-wide, which is precisely the mistake the region scoping
-- exists to prevent: a tenant operating in two countries would close the wrong
-- offices. Additive and nullable — a schedule with no region simply has no
-- holidays subtracted, which is honest rather than guessing at one.
--
-- Idempotent + re-runnable; rollback in ../down/002_schedule_region.down.sql.

ALTER TABLE coverage.work_schedule
  ADD COLUMN IF NOT EXISTS holiday_region TEXT;

COMMENT ON COLUMN coverage.work_schedule.holiday_region IS
  'Matches coverage.holiday_calendar.region for this tenant. NULL means no holiday calendar applies to this persona — no holidays are subtracted rather than a default region being assumed.';

CREATE INDEX IF NOT EXISTS work_schedule_region_idx
  ON coverage.work_schedule (tenant_id, holiday_region)
  WHERE holiday_region IS NOT NULL;
