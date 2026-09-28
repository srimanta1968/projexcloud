-- Migration 004: sdk-voice-agent — app_id is a TEXT app identifier, not a UUID. VA·E2.
-- Auto-applied via api-gateway runMigrations.
--
-- 001 typed agent.app_id and app_tool.app_id as UUID, but ProjexCloud app identifiers
-- are text slugs (signup returns e.g. 'appid-1790637274916-ea9975', and the JWT app_id
-- claim carries the same form). A consumer app therefore could not tag its agents at
-- all. Widening UUID -> TEXT is lossless for any existing value.
--
-- The app_tool name index COALESCEs a NULL app_id to a sentinel so two NULL-app tools of
-- the same name still collide; it has to be rebuilt with a TEXT sentinel.
--
-- Idempotent: the ALTERs are no-ops once the columns are TEXT; down in ../down/.

DROP INDEX IF EXISTS voice_agent.voice_app_tool_name_idx;

ALTER TABLE voice_agent.agent    ALTER COLUMN app_id TYPE TEXT USING app_id::text;
ALTER TABLE voice_agent.app_tool ALTER COLUMN app_id TYPE TEXT USING app_id::text;

CREATE UNIQUE INDEX IF NOT EXISTS voice_app_tool_name_idx
  ON voice_agent.app_tool (tenant_id, COALESCE(app_id, ''), name);

COMMENT ON COLUMN voice_agent.agent.app_id IS 'The consumer app that owns this agent — a ProjexCloud app identifier (text), loose reference.';
COMMENT ON COLUMN voice_agent.app_tool.app_id IS 'The consumer app that registered the tool — a ProjexCloud app identifier (text), loose reference.';
