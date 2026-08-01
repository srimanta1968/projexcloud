-- Global fixture seed for sdk-data-credits (EP-378). Runs automatically before every
-- suite, so any fresh environment gets the catalog the api_definitions reference by
-- fixed key (tests/config/test-config.json -> variables.data_credits_capability_key).
--
-- The capability catalog and its provider bindings are genuinely PRODUCER-LESS: there is
-- no create endpoint for either, by design. The catalog is platform reference data, and
-- provider_binding is deliberately unreachable from any tenant-scoped API — that is the
-- whole vendor-opacity promise, so a seed is the only correct way to establish one.
--
-- Idempotent (ON CONFLICT DO NOTHING). Test/dev only — never a production path.

-- The platform catalog row. tenant_id NULL = the list price; a tenant row would override
-- it for that tenant only.
INSERT INTO data_credits.capability
  (capability_id, tenant_id, key, outcome_label, description, credit_price, category, metadata)
VALUES (
  '00000000-0000-4000-8000-00000000dc01', NULL, 'validate.phone-smoke',
  'Validate a phone number', 'Confirms the number is reachable and reports its line type',
  1.0000, 'validation', '{"cache_ttl_seconds": 3600}'::jsonb
)
ON CONFLICT (capability_id) DO NOTHING;

-- Two bindings so the fallback chain is a chain, not a single provider. Priority 1 is
-- tried first; both point at a secret REFERENCE, never at a credential — the CHECK on
-- secret_ref refuses anything that is not a secret:// pointer.
INSERT INTO data_credits.provider_binding
  (binding_id, capability_id, provider_key, secret_ref, priority, health_state, true_cost_micros)
VALUES
  ('00000000-0000-4000-8000-00000000db01', '00000000-0000-4000-8000-00000000dc01',
   'smoke-primary', 'secret://platform/smoke-primary', 1, 'HEALTHY', 1200),
  ('00000000-0000-4000-8000-00000000db02', '00000000-0000-4000-8000-00000000dc01',
   'smoke-secondary', 'secret://platform/smoke-secondary', 2, 'HEALTHY', 900)
ON CONFLICT (binding_id) DO NOTHING;
