-- Migration 009: sdk-voice-agent — the recipient's timezone on a call. VA·E5 (TK-4482).
-- Auto-applied via api-gateway runMigrations.
--
-- The dialer's calling-window gate needs the RECIPIENT's local time. A campaign contact
-- carries its own timezone; a single API call can now name one too. When it is null the
-- gate checks the window in every timezone of the number's country (strict).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS recipient_timezone TEXT;
