-- Rollback for 004_breach.sql (sdk-sla). NOT auto-applied — forward-only.
DROP TRIGGER IF EXISTS breach_record_cause_immutable_trg ON sla.breach_record;
DROP FUNCTION IF EXISTS sla.reject_breach_cause_change();
DROP TRIGGER IF EXISTS systemic_incident_touch_trg ON sla.systemic_incident;
DROP TRIGGER IF EXISTS breach_reason_touch_trg ON sla.breach_reason;
DROP TABLE IF EXISTS sla.breach_record;
DROP TABLE IF EXISTS sla.systemic_incident;
DROP TABLE IF EXISTS sla.breach_reason;
