-- Rollback for 001_init_coverage.sql (sdk-coverage). NOT auto-applied — forward-only.
DROP TABLE IF EXISTS coverage.backup_designation;
DROP TABLE IF EXISTS coverage.on_call_roster;
DROP TABLE IF EXISTS coverage.capacity_policy;
DROP TABLE IF EXISTS coverage.presence;
DROP TABLE IF EXISTS coverage.holiday_calendar;
DROP TABLE IF EXISTS coverage.time_off;
DROP TABLE IF EXISTS coverage.work_schedule;
DROP FUNCTION IF EXISTS coverage.is_named_timezone(TEXT);
DROP FUNCTION IF EXISTS coverage.touch_updated_at();
DROP TYPE IF EXISTS coverage.presence_source;
DROP TYPE IF EXISTS coverage.presence_status;
DROP TYPE IF EXISTS coverage.time_off_kind;
DROP SCHEMA IF EXISTS coverage;
