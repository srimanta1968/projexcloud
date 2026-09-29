-- Migration 009: sdk-crm — AI call activity fields (VA·E8 · TK-4506).
-- Auto-applied by the migration runner at boot. ADDITIVE + idempotent.
--
-- A call placed or answered by an AI voice agent lands on the contact/lead
-- timeline like any other call, but a reader must be able to tell it was the
-- AI talking, WHICH agent version said it, and what the agent concluded:
--
--   actor_kind          'human' (default — every existing row) | 'ai_agent'
--   ai_agent_id         the sdk-voice-agent agent that handled the call
--   ai_agent_version_id the exact published version (prompt + tools) in effect,
--                       so a later prompt change never rewrites history
--   ai_disposition      the agent's own outcome (e.g. interested, callback,
--                       opt_out) — richer than call_disposition, which stays the
--                       telephony outcome (answered / no_answer / voicemail ...)
--
-- actor_persona_id stays NOT NULL: for an AI call it is the persona the agent
-- acts for (its acting persona, or whoever requested the call).

ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'human';
ALTER TABLE crm.activity DROP CONSTRAINT IF EXISTS activity_actor_kind_check;
ALTER TABLE crm.activity ADD  CONSTRAINT activity_actor_kind_check
  CHECK (actor_kind IN ('human', 'ai_agent'));

ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS ai_agent_id UUID;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS ai_agent_version_id UUID;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS ai_disposition TEXT;

ALTER TABLE crm.activity DROP CONSTRAINT IF EXISTS activity_ai_disposition_check;
ALTER TABLE crm.activity ADD  CONSTRAINT activity_ai_disposition_check
  CHECK (ai_disposition IS NULL OR (length(btrim(ai_disposition)) BETWEEN 1 AND 64));

-- An AI activity always names its agent and version; a human one never does.
ALTER TABLE crm.activity DROP CONSTRAINT IF EXISTS activity_ai_agent_ref_check;
ALTER TABLE crm.activity ADD  CONSTRAINT activity_ai_agent_ref_check
  CHECK (
    (actor_kind = 'ai_agent' AND ai_agent_id IS NOT NULL AND ai_agent_version_id IS NOT NULL)
    OR (actor_kind = 'human' AND ai_agent_id IS NULL AND ai_agent_version_id IS NULL AND ai_disposition IS NULL)
  );

CREATE INDEX IF NOT EXISTS crm_activity_ai_agent_idx
  ON crm.activity (ai_agent_id, occurred_at DESC) WHERE ai_agent_id IS NOT NULL;

COMMENT ON COLUMN crm.activity.actor_kind IS 'Who performed the activity: human (a persona) or ai_agent (an sdk-voice-agent agent acting for actor_persona_id).';
COMMENT ON COLUMN crm.activity.ai_agent_version_id IS 'The published agent version that handled an AI call — pins the prompt/tools in effect.';
COMMENT ON COLUMN crm.activity.ai_disposition IS 'The AI agent''s own call outcome; call_disposition remains the telephony outcome.';
