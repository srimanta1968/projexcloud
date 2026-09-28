-- Rollback for 001_init_voice_agent.sql (VA·E2, TK-4468).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent.

DROP FUNCTION IF EXISTS voice_agent.resolve_number(TEXT);
DROP TABLE IF EXISTS voice_agent.call_turn CASCADE;
DROP TABLE IF EXISTS voice_agent.call CASCADE;
DROP TABLE IF EXISTS voice_agent.app_tool CASCADE;
DROP TABLE IF EXISTS voice_agent.number_binding CASCADE;
DROP TABLE IF EXISTS voice_agent.agent_version CASCADE;
DROP TABLE IF EXISTS voice_agent.agent CASCADE;
DROP TABLE IF EXISTS voice_agent.stack_profile CASCADE;
DROP SCHEMA IF EXISTS voice_agent RESTRICT;
