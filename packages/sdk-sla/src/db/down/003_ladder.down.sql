-- Rollback for 003_ladder.sql (sdk-sla). NOT auto-applied — forward-only.
DROP TRIGGER IF EXISTS rung_firing_no_unfire_trg ON sla.rung_firing;
DROP FUNCTION IF EXISTS sla.reject_unfiring();
DROP TRIGGER IF EXISTS ladder_rung_touch_trg ON sla.ladder_rung;
DROP TABLE IF EXISTS sla.rung_firing;
DROP TABLE IF EXISTS sla.ladder_rung;
DROP TYPE IF EXISTS sla.rung_firing_state;
DROP TYPE IF EXISTS sla.rung_severity;
