-- Rollback for 004_app_id_text.sql. NOT auto-applied.
-- Only valid when every app_id is NULL or a uuid; a slug-form app_id cannot go back.
DROP INDEX IF EXISTS voice_agent.voice_app_tool_name_idx;
ALTER TABLE voice_agent.agent    ALTER COLUMN app_id TYPE UUID USING app_id::uuid;
ALTER TABLE voice_agent.app_tool ALTER COLUMN app_id TYPE UUID USING app_id::uuid;
CREATE UNIQUE INDEX IF NOT EXISTS voice_app_tool_name_idx
  ON voice_agent.app_tool (tenant_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
