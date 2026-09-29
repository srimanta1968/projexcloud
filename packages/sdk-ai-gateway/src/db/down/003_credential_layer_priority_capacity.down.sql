-- Rollback for 003_credential_layer_priority_capacity.sql. NOT auto-applied.
-- Fails if voice-layer rows exist whose provider is not in ai_gateway.provider;
-- revoke or delete those first.
DROP INDEX IF EXISTS ai_gateway.tenant_provider_credential_layer_idx;
DROP INDEX IF EXISTS ai_gateway.tenant_provider_credential_active_layer_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_provider_credential_active_uniq
  ON ai_gateway.tenant_provider_credential (tenant_id, provider_id) WHERE status = 'active';
ALTER TABLE ai_gateway.tenant_provider_credential
  ADD CONSTRAINT tenant_provider_credential_provider_id_fkey
  FOREIGN KEY (provider_id) REFERENCES ai_gateway.provider(provider_id) ON DELETE RESTRICT;
ALTER TABLE ai_gateway.tenant_provider_credential
  DROP CONSTRAINT IF EXISTS tenant_provider_credential_layer_chk,
  DROP CONSTRAINT IF EXISTS tenant_provider_credential_priority_chk,
  DROP CONSTRAINT IF EXISTS tenant_provider_credential_validation_chk,
  DROP CONSTRAINT IF EXISTS tenant_provider_credential_concurrency_chk,
  DROP COLUMN IF EXISTS validation_error,
  DROP COLUMN IF EXISTS validated_at,
  DROP COLUMN IF EXISTS max_concurrency,
  DROP COLUMN IF EXISTS rate_limit_tier,
  DROP COLUMN IF EXISTS validation_status,
  DROP COLUMN IF EXISTS priority,
  DROP COLUMN IF EXISTS layer;
