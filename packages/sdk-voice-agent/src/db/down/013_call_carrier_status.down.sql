-- Rollback for 013_call_carrier_status.sql. NOT auto-applied.
DROP INDEX IF EXISTS voice_agent.voice_call_carrier_sid_uniq;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS carrier_status;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS carrier_call_sid;
