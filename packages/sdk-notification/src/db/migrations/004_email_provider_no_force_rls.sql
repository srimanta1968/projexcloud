-- Migration 004: sdk-notification · relax FORCE RLS on tenant_provider_credential.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup. Idempotent.
--
-- 003 enabled FORCE ROW LEVEL SECURITY, which subjects even the table OWNER
-- (the admin-pool connection the emailProviderService writes through) to the
-- tenant_isolation policy. That connection does not set the per-request
-- app.tenant_id GUC, so binds/rotates/revokes were blocked.
--
-- Match the ai_gateway.tenant_provider_credential pattern: RLS stays ENABLED
-- (isolates non-owner tenant connections) but NOT FORCED, so the owner-scoped
-- service can write. Tenant isolation for those writes is still guaranteed:
-- emailProviderService scopes every statement by tenant_id = $1 explicitly.

ALTER TABLE notification.tenant_provider_credential NO FORCE ROW LEVEL SECURITY;
