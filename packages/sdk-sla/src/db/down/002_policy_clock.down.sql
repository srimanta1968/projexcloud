-- Rollback for 002_policy_clock.sql (sdk-sla). NOT auto-applied — forward-only.
DROP TRIGGER IF EXISTS sla_clock_timing_immutable_trg ON sla.sla_clock;
DROP FUNCTION IF EXISTS sla.reject_clock_timing_change();
DROP TRIGGER IF EXISTS sla_policy_touch_trg ON sla.sla_policy;
DROP TABLE IF EXISTS sla.sla_clock;
DROP TABLE IF EXISTS sla.sla_policy;
DROP TYPE IF EXISTS sla.clock_state;
