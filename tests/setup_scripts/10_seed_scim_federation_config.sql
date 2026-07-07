-- Seeds a SCIM federation_config row so POST /scim/v2/Users authenticates.
--
-- scimBearerAuth (packages/sdk-identity/src/middleware/scimAuthMiddleware.ts)
-- SHA-256s the incoming `Authorization: Bearer <token>` and looks up
--   identity.federation_config
--     WHERE protocol='scim'
--       AND (scim_bearer_envelope = <sha256(token)> OR scim_bearer_envelope IS NULL)
--       AND jit_enabled = TRUE
-- 401ing ("SCIM Bearer token not recognized") when no row matches. signup-tenant
-- never provisions a SCIM federation, so on a fresh DB every SCIM call 401s.
--
-- We seed the exact SHA-256 of the test-config `scim_bearer_token`
-- ('test-scim-bearer-token') so the specific token is genuinely validated
-- (not the NULL dev-wildcard path). The handler then provisions into the
-- x-tenant-id header the def supplies (the run's dynamic signup tenant), so this
-- row's own tenant_id is a fixed placeholder never used for provisioning.
--
-- sha256('test-scim-bearer-token') =
--   540e71482d54b84223a2a4cda79b4ff95fc4b70f92a8f64a6a2da25566fc4386
-- Idempotent: re-running refreshes the envelope/jit flag for the fixed row.

INSERT INTO identity.federation_config
  (federation_id, tenant_id, protocol, scim_bearer_envelope, jit_enabled)
VALUES
  ('00000000-0000-4000-8000-00000000fed0'::uuid,
   '00000000-0000-4000-8000-0000000000f1'::uuid,
   'scim',
   decode('540e71482d54b84223a2a4cda79b4ff95fc4b70f92a8f64a6a2da25566fc4386', 'hex'),
   TRUE)
ON CONFLICT (tenant_id, protocol) DO UPDATE
  SET scim_bearer_envelope = EXCLUDED.scim_bearer_envelope,
      jit_enabled = TRUE;
