-- Rollback for 010_call_voicemail_action.sql. NOT auto-applied.
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS voicemail_action;
