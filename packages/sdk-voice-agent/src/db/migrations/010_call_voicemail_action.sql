-- Migration 010: sdk-voice-agent — what was done when a machine answered. VA·E5 (TK-4486).
-- Auto-applied via api-gateway runMigrations.
--
-- The carrier's answering-machine detection lands in answered_by (human | machine |
-- unknown, already on the call). When it is a machine the dialer applies the campaign's
-- voicemail policy and records the action here: drop_tts (speak the campaign message),
-- drop_recording (play a recorded message) or hang_up. NULL = no machine was detected.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS voicemail_action TEXT
  CHECK (voicemail_action IS NULL OR voicemail_action IN ('drop_tts','drop_recording','hang_up'));
