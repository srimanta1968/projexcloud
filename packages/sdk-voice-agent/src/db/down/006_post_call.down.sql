-- Rollback for 006_post_call.sql. NOT auto-applied.
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS post_call;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS conversation_thread_id;
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS crm_encounter_id;
