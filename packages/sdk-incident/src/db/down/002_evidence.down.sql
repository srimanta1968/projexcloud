-- Down for 002_evidence.sql (sdk-incident evidence timeline, P15 · E3 TK-3651).
-- The append-only trigger must go first: it blocks DELETE, but DROP TABLE is DDL
-- and is unaffected — dropping it explicitly keeps the teardown order obvious.

DROP TRIGGER IF EXISTS incident_evidence_append_only ON incident.evidence;
DROP FUNCTION IF EXISTS incident.evidence_append_only();
DROP INDEX IF EXISTS incident.incident_evidence_tenant_idx;
DROP INDEX IF EXISTS incident.incident_evidence_timeline_idx;
DROP TABLE IF EXISTS incident.evidence;
