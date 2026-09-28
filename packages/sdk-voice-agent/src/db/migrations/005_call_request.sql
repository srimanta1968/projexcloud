-- Migration 005: sdk-voice-agent — AI call request bookkeeping. VA·E2 (TK-4474).
-- Auto-applied via api-gateway runMigrations.
--
-- request_hash is a sha256 of the canonical request body a call was placed with. It lets
-- POST /api/voice-agent/calls tell a genuine retry (same Idempotency-Key, same body ->
-- replay the stored call) from a key reused for a DIFFERENT call (-> 422), which a
-- UNIQUE (tenant_id, idempotency_key) alone cannot distinguish.
-- requested_by is the persona/app that asked for the call, for the audit trail.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS request_hash TEXT;
ALTER TABLE voice_agent.call ADD COLUMN IF NOT EXISTS requested_by TEXT;
CREATE INDEX IF NOT EXISTS voice_call_status_idx ON voice_agent.call (tenant_id, status, created_at DESC);
