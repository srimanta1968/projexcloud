-- Migration 006: sdk-voice-agent — post-call mirroring links. VA·E2 (TK-4475).
-- Auto-applied via api-gateway runMigrations.
--
-- crm_encounter_id  the sdk-crm/sdk-engagement encounter whose timeline gets the call activity
--                   (the CRM timeline is keyed by encounter, not by subject_ref).
-- conversation_thread_id  the sdk-conversation thread the turns were mirrored to; pinned by the
--                   caller or resolved from subject_ref on completion.
-- post_call         what post-call processing did: summary_source, mirror results and any
--                   per-target error, so a partial mirror is visible and a retry can finish it.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS crm_encounter_id UUID;
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS conversation_thread_id UUID;
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS post_call JSONB NOT NULL DEFAULT '{}'::jsonb;
