-- Down for 002_recording_consent.sql (P15 · E4, TK-3654).

ALTER TABLE connector_twilio_voice.voice_call DROP COLUMN IF EXISTS recording_withheld_reason;
ALTER TABLE connector_twilio_voice.voice_call DROP COLUMN IF EXISTS recording_consent_receipt_id;
ALTER TABLE connector_twilio_voice.voice_call DROP COLUMN IF EXISTS recording_consent;
