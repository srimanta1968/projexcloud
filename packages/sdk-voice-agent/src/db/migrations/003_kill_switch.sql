-- Migration 003: sdk-voice-agent — per-agent kill switch. VA·E2 (TK-4472).
-- Auto-applied via api-gateway runMigrations.
--
-- Tripping the kill switch takes an agent out of service immediately without
-- unpublishing it: inbound routing sends callers to the number's fallback, and the
-- voice runtime ends in-flight calls with kill_message. Kept on the agent row (not only
-- in sdk-feature-flags) because the runtime reads it on the same lookup that routes the
-- call — one read, no extra hop on the answer path.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.

ALTER TABLE voice_agent.agent ADD COLUMN IF NOT EXISTS kill_switch_engaged BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE voice_agent.agent ADD COLUMN IF NOT EXISTS kill_message TEXT;
ALTER TABLE voice_agent.agent ADD COLUMN IF NOT EXISTS kill_engaged_at TIMESTAMPTZ;
ALTER TABLE voice_agent.agent ADD COLUMN IF NOT EXISTS kill_engaged_by TEXT;

COMMENT ON COLUMN voice_agent.agent.kill_switch_engaged IS 'True = agent out of service: inbound calls take the number fallback and live calls end with kill_message.';
COMMENT ON COLUMN voice_agent.agent.kill_message IS 'What the agent says before ending a call when the kill switch is engaged.';
