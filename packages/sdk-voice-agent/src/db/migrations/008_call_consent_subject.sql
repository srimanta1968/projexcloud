-- Migration 008: sdk-voice-agent — whose consent an outbound call is checked against. VA·E5 (TK-4481).
-- Auto-applied via api-gateway runMigrations.
--
-- sdk-consent keys receipts by person_id + purpose + processor + jurisdiction; subject_ref
-- ("lead:123") is the consumer's own id and cannot be looked up there. person_id names the
-- person whose ai_voice_outbound consent the dialer's consent gate checks; jurisdiction
-- (e.g. US, US-CA, GB) selects the receipt, and defaults from the number's country code.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS person_id UUID;
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
