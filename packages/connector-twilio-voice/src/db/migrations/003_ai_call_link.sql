-- Migration 003: connector-twilio-voice — link mirror rows to AI calls. VA·E6 (TK-4500).
-- Auto-applied via api-gateway runMigrations.
--
-- A call leg the voice agent placed or answered is a voice_agent.call; when Twilio also has a
-- mirror row for the same CallSid, ai_call_id points at it (a loose ref — the connector does
-- not depend on sdk-voice-agent). Status callbacks for the CallSid then update both.
--
-- Idempotent; down in ../down/.

ALTER TABLE connector_twilio_voice.voice_call ADD COLUMN IF NOT EXISTS ai_call_id UUID;
CREATE INDEX IF NOT EXISTS twilio_voice_call_ai_call_idx
  ON connector_twilio_voice.voice_call (ai_call_id) WHERE ai_call_id IS NOT NULL;
