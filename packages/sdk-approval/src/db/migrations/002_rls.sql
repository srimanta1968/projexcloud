-- Migration 002: Row-Level Security (RLS) for sdk-approval tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   approval.route   — direct tenant_id
--   approval.request — direct tenant_id
--   approval.step    — joins via request_id → approval.request.tenant_id

-- approval.route
ALTER TABLE approval.route ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval.route FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval.route;
CREATE POLICY tenant_isolation ON approval.route
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- approval.request
ALTER TABLE approval.request ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval.request FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval.request;
CREATE POLICY tenant_isolation ON approval.request
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- approval.step — join via request_id
ALTER TABLE approval.step ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval.step FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval.step;
CREATE POLICY tenant_isolation ON approval.step
  USING (EXISTS (
    SELECT 1 FROM approval.request r
    WHERE r.request_id = step.request_id
      AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM approval.request r
    WHERE r.request_id = step.request_id
      AND r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
