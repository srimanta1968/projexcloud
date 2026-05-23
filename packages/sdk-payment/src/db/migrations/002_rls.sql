-- Migration 002: Row-Level Security (RLS) for sdk-payment tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   payment.payment_method — direct tenant_id
--   payment.charge         — direct tenant_id
--   payment.refund         — joins via charge_id → payment.charge.tenant_id
--   payment.distribution   — joins via charge_id → payment.charge.tenant_id

-- payment.payment_method
ALTER TABLE payment.payment_method ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.payment_method FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment.payment_method;
CREATE POLICY tenant_isolation ON payment.payment_method
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- payment.charge
ALTER TABLE payment.charge ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.charge FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment.charge;
CREATE POLICY tenant_isolation ON payment.charge
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- payment.refund — join via charge_id
ALTER TABLE payment.refund ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.refund FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment.refund;
CREATE POLICY tenant_isolation ON payment.refund
  USING (EXISTS (
    SELECT 1 FROM payment.charge c
    WHERE c.charge_id = refund.charge_id
      AND c.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM payment.charge c
    WHERE c.charge_id = refund.charge_id
      AND c.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- payment.distribution — join via charge_id
ALTER TABLE payment.distribution ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment.distribution FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON payment.distribution;
CREATE POLICY tenant_isolation ON payment.distribution
  USING (EXISTS (
    SELECT 1 FROM payment.charge c
    WHERE c.charge_id = distribution.charge_id
      AND c.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM payment.charge c
    WHERE c.charge_id = distribution.charge_id
      AND c.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
