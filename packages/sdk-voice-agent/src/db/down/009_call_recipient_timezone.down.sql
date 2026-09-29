-- Rollback for 009_call_recipient_timezone.sql. NOT auto-applied.
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS recipient_timezone;
