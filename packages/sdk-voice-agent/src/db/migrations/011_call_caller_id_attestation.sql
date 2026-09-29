-- Migration 011: sdk-voice-agent — STIR/SHAKEN attestation of the caller ID used. VA·E5 (TK-4487).
-- Auto-applied via api-gateway runMigrations.
--
-- The dialer picks an outbound call's caller ID from the tenant's pool at dispatch and
-- stores it in from_number; this is the attestation level (A | B | C) it was signed at.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS caller_id_attestation TEXT
  CHECK (caller_id_attestation IS NULL OR caller_id_attestation IN ('A','B','C'));
