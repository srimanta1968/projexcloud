-- Migration 003: sdk-ai-gateway · tenant credentials for every voice layer. VA·E3 (TK-4497).
--
-- Tenant BYOK bindings were LLM-only: one active key per (tenant, provider), provider_id
-- a foreign key into the platform ai_gateway.provider table. A voice agent also needs the
-- tenant's STT, TTS, realtime and telephony keys, each with an optional secondary for
-- failover, and the capacity the key's rate-limit tier allows. This migration is
-- additive:
--
--   layer     llm | stt | tts | realtime | telephony   (existing rows backfill to llm)
--   priority  primary | secondary                       (existing rows backfill to primary)
--   capacity  validation_status, rate_limit_tier, max_concurrency, validated_at,
--             validation_error — written by the key-validation probe (TK-4491)
--
-- provider_id is no longer a foreign key: speech and telephony providers (deepgram,
-- cartesia, twilio, ...) have no platform credential, so they cannot live in
-- ai_gateway.provider (credential_envelope is NOT NULL there). The service validates the
-- provider against the layer's allowed set instead. The completion resolver reads only
-- layer = 'llm' rows, so LLM behaviour is unchanged.
--
-- Auto-applied by the api-gateway migration runner. Idempotent; down in ../down/.

ALTER TABLE ai_gateway.tenant_provider_credential
  ADD COLUMN IF NOT EXISTS layer TEXT NOT NULL DEFAULT 'llm',
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'primary',
  ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'unvalidated',
  ADD COLUMN IF NOT EXISTS rate_limit_tier TEXT,
  ADD COLUMN IF NOT EXISTS max_concurrency INTEGER,
  ADD COLUMN IF NOT EXISTS validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validation_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_provider_credential_layer_chk') THEN
    ALTER TABLE ai_gateway.tenant_provider_credential
      ADD CONSTRAINT tenant_provider_credential_layer_chk
        CHECK (layer IN ('llm','stt','tts','realtime','telephony'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_provider_credential_priority_chk') THEN
    ALTER TABLE ai_gateway.tenant_provider_credential
      ADD CONSTRAINT tenant_provider_credential_priority_chk
        CHECK (priority IN ('primary','secondary'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_provider_credential_validation_chk') THEN
    ALTER TABLE ai_gateway.tenant_provider_credential
      ADD CONSTRAINT tenant_provider_credential_validation_chk
        CHECK (validation_status IN ('unvalidated','ok','invalid_key','insufficient_permissions',
                                     'rate_limited','provider_error','unsupported'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_provider_credential_concurrency_chk') THEN
    ALTER TABLE ai_gateway.tenant_provider_credential
      ADD CONSTRAINT tenant_provider_credential_concurrency_chk
        CHECK (max_concurrency IS NULL OR max_concurrency > 0);
  END IF;
END $$;

-- Speech/telephony providers are not platform providers; validated in the service.
ALTER TABLE ai_gateway.tenant_provider_credential
  DROP CONSTRAINT IF EXISTS tenant_provider_credential_provider_id_fkey;

-- One active key per (tenant, provider, layer, priority): the same OpenAI key may serve
-- both the llm and tts layers, and a layer may hold a primary and a secondary.
DROP INDEX IF EXISTS ai_gateway.tenant_provider_credential_active_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_provider_credential_active_layer_uniq
  ON ai_gateway.tenant_provider_credential (tenant_id, provider_id, layer, priority)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS tenant_provider_credential_layer_idx
  ON ai_gateway.tenant_provider_credential (tenant_id, layer, priority, status);

COMMENT ON COLUMN ai_gateway.tenant_provider_credential.layer
  IS 'Voice layer the key serves: llm | stt | tts | realtime | telephony. The completion resolver reads llm only.';
COMMENT ON COLUMN ai_gateway.tenant_provider_credential.max_concurrency
  IS 'Max safe concurrent calls the key''s rate-limit tier allows, from the capacity probe; NULL = unknown.';
