-- Migration 002: Row-Level Security (RLS) for sdk-notification tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   notification.template — tenant_id nullable (NULL = platform default, readable by all tenants)
--   notification.message  — direct tenant_id (NOT NULL)
--   notification.quiet_hours — keyed by persona_id only; no tenant_id column,
--                              so no RLS attached (audit assumption mismatched schema).

-- notification.template — tenant_id NULL is platform-default; allow read by every tenant.
ALTER TABLE notification.template ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.template FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.template;
CREATE POLICY tenant_isolation ON notification.template
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- notification.message — direct tenant_id
ALTER TABLE notification.message ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.message FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.message;
CREATE POLICY tenant_isolation ON notification.message
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
