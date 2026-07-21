-- Migration 005: sdk-crm — call-activity idempotency key. P15 · E5 (TK-3656).
-- Auto-applied by the migration runner at boot.
--
-- Calls and voicemails are logged from connector-twilio-voice webhooks, and
-- Twilio RETRIES its callbacks. Without a uniqueness key on the upstream call id
-- every retry would append a duplicate activity to the contact timeline. A
-- partial UNIQUE index on external_call_id makes logCall/logVoicemail an upsert
-- keyed on the provider's call id (Twilio Call SIDs are globally unique, so the
-- key needs no tenant qualifier); rows with no external_call_id (manually logged
-- calls) are excluded and may repeat freely.
--
-- Replaces the plain lookup index added in 003 — the unique index serves the
-- same read path, so keeping both would be redundant.
--
-- ADDITIVE + idempotent (IF NOT EXISTS / IF EXISTS); down in ../down/.

DROP INDEX IF EXISTS crm.crm_activity_external_call_idx;

CREATE UNIQUE INDEX IF NOT EXISTS crm_activity_external_call_uidx
  ON crm.activity (external_call_id) WHERE external_call_id IS NOT NULL;

COMMENT ON INDEX crm.crm_activity_external_call_uidx IS
  'Idempotency key for webhook-driven call/voicemail logging: one activity per provider call id. Partial, so manually logged activities (no external_call_id) are unconstrained.';
