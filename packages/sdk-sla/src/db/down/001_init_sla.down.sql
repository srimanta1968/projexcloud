-- Rollback for 001_init_sla.sql (sdk-sla). NOT auto-applied — forward-only ledger.
DROP TRIGGER IF EXISTS business_calendar_touch_trg ON sla.business_calendar;
DROP FUNCTION IF EXISTS sla.touch_updated_at();
DROP TABLE IF EXISTS sla.business_calendar;
DROP TYPE IF EXISTS sla.weekend_rule;
DROP SCHEMA IF EXISTS sla CASCADE;
