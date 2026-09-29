-- Rollback for 008_call_consent_subject.sql. NOT auto-applied.
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS jurisdiction;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS person_id;
