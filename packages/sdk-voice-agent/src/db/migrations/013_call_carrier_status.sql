-- Migration 013: sdk-voice-agent — carrier call identity and status. VA·E6 (TK-4500).
-- Auto-applied via api-gateway runMigrations.
--
-- carrier_call_sid  the carrier's id for the call leg (Twilio CallSid), reported by the voice
--                   runtime once the SIP leg exists. Carrier status callbacks are keyed on it,
--                   so it is unique platform-wide.
-- carrier_status    the last raw carrier status seen (queued/ringing/in-progress/busy/...).
--
-- Idempotent; down in ../down/.

ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS carrier_call_sid TEXT;
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS carrier_status TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS voice_call_carrier_sid_uniq
  ON voice_agent.call (carrier_call_sid) WHERE carrier_call_sid IS NOT NULL;
