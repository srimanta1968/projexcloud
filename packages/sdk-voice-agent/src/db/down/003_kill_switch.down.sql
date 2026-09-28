-- Rollback for 003_kill_switch.sql (VA·E2, TK-4472). NOT auto-applied. Idempotent.
ALTER TABLE voice_agent.agent DROP COLUMN IF EXISTS kill_engaged_by;
ALTER TABLE voice_agent.agent DROP COLUMN IF EXISTS kill_engaged_at;
ALTER TABLE voice_agent.agent DROP COLUMN IF EXISTS kill_message;
ALTER TABLE voice_agent.agent DROP COLUMN IF EXISTS kill_switch_engaged;
