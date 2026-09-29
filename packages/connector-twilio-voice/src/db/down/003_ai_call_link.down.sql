-- Rollback for 003_ai_call_link.sql. NOT auto-applied.
DROP INDEX IF EXISTS connector_twilio_voice.twilio_voice_call_ai_call_idx;
ALTER TABLE connector_twilio_voice.voice_call DROP COLUMN IF EXISTS ai_call_id;
