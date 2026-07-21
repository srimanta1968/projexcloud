-- Migration 002: connector-twilio-voice — recording-consent decision. P15 · E4 (TK-3654).
-- Auto-applied via api-gateway runMigrations.
--
-- Recording a call is PII processing, so it is gated on an sdk-consent decision.
-- These columns record WHAT WAS DECIDED and WHY a recording was withheld, so the
-- gate is auditable after the fact rather than only being a runtime branch.
--
-- recording_consent tri-state:
--   TRUE  = consent granted, the recording pointer may be stored
--   FALSE = a decision was made and it was DENIED
--   NULL  = NO DECISION available (unknown) — treated exactly like denied for
--           storage purposes, because "no recording stored without a consent
--           decision" means the absence of a decision must fail closed.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.

ALTER TABLE connector_twilio_voice.voice_call
  ADD COLUMN IF NOT EXISTS recording_consent BOOLEAN;
ALTER TABLE connector_twilio_voice.voice_call
  ADD COLUMN IF NOT EXISTS recording_consent_receipt_id UUID;
ALTER TABLE connector_twilio_voice.voice_call
  ADD COLUMN IF NOT EXISTS recording_withheld_reason TEXT
    CHECK (recording_withheld_reason IN ('consent_denied','consent_unknown','not_requested'));

COMMENT ON COLUMN connector_twilio_voice.voice_call.recording_consent IS
  'sdk-consent decision for call recording: true=granted, false=denied, NULL=no decision. NULL and false both withhold the recording.';
COMMENT ON COLUMN connector_twilio_voice.voice_call.recording_consent_receipt_id IS
  'The sdk-consent receipt that authorised recording — the audit trail for why the pointer was stored.';
COMMENT ON COLUMN connector_twilio_voice.voice_call.recording_withheld_reason IS
  'Why recording_url is absent despite a recording existing upstream.';
