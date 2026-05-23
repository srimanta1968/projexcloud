-- Migration 002: Row-Level Security (RLS) for sdk-workflow tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   workflow.run          — tenant_id nullable (platform admin flows have NULL)
--   workflow.step         — joins via run_id → workflow.run.tenant_id
--   workflow.compensation — joins via step_id → workflow.step → workflow.run
--   workflow.definition   — PLATFORM-scoped registry; no RLS attached.

-- workflow.run — nullable tenant_id; NULL rows are platform-scoped (visible to all sessions).
ALTER TABLE workflow.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.run;
CREATE POLICY tenant_isolation ON workflow.run
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );

-- workflow.step — join via run_id
ALTER TABLE workflow.step ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.step FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.step;
CREATE POLICY tenant_isolation ON workflow.step
  USING (EXISTS (
    SELECT 1 FROM workflow.run r
    WHERE r.run_id = step.run_id
      AND (
        r.tenant_id IS NULL
        OR r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM workflow.run r
    WHERE r.run_id = step.run_id
      AND (
        r.tenant_id IS NULL
        OR r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
  ));

-- workflow.compensation — chains step_id -> step -> run
ALTER TABLE workflow.compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.compensation FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workflow.compensation;
CREATE POLICY tenant_isolation ON workflow.compensation
  USING (EXISTS (
    SELECT 1 FROM workflow.step s
    JOIN workflow.run r ON r.run_id = s.run_id
    WHERE s.step_id = compensation.step_id
      AND (
        r.tenant_id IS NULL
        OR r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM workflow.step s
    JOIN workflow.run r ON r.run_id = s.run_id
    WHERE s.step_id = compensation.step_id
      AND (
        r.tenant_id IS NULL
        OR r.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
  ));
