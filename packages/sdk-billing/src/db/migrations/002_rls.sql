-- Migration 002: Row-Level Security (RLS) for sdk-billing tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   billing.invoice          — direct tenant_id
--   billing.line_item        — joins via invoice_id → billing.invoice.tenant_id
--   billing.dunning_state    — joins via invoice_id → billing.invoice.tenant_id
--   billing.reprice_dry_run  — direct tenant_id (nullable; NULL rows are platform-level)

-- billing.invoice
ALTER TABLE billing.invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.invoice FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.invoice;
CREATE POLICY tenant_isolation ON billing.invoice
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- billing.line_item — join via invoice_id
ALTER TABLE billing.line_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.line_item FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.line_item;
CREATE POLICY tenant_isolation ON billing.line_item
  USING (EXISTS (
    SELECT 1 FROM billing.invoice i
    WHERE i.invoice_id = line_item.invoice_id
      AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM billing.invoice i
    WHERE i.invoice_id = line_item.invoice_id
      AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- billing.dunning_state — audit said tenant_id but schema joins via invoice_id
ALTER TABLE billing.dunning_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.dunning_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.dunning_state;
CREATE POLICY tenant_isolation ON billing.dunning_state
  USING (EXISTS (
    SELECT 1 FROM billing.invoice i
    WHERE i.invoice_id = dunning_state.invoice_id
      AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM billing.invoice i
    WHERE i.invoice_id = dunning_state.invoice_id
      AND i.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- billing.reprice_dry_run — tenant_id nullable; NULL = platform-wide what-if.
ALTER TABLE billing.reprice_dry_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.reprice_dry_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.reprice_dry_run;
CREATE POLICY tenant_isolation ON billing.reprice_dry_run
  USING (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id IS NULL
    OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
