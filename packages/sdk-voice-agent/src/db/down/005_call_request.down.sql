-- Rollback for 005_call_request.sql. NOT auto-applied.
DROP INDEX IF EXISTS voice_agent.voice_call_status_idx;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS requested_by;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS request_hash;
