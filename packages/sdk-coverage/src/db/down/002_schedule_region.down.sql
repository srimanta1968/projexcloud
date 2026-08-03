-- Rollback for 002_schedule_region.sql (sdk-coverage). NOT auto-applied — forward-only.
DROP INDEX IF EXISTS coverage.work_schedule_region_idx;
ALTER TABLE coverage.work_schedule DROP COLUMN IF EXISTS holiday_region;
