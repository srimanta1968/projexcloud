-- Migration 002: Row-Level Security (RLS) for sdk-webhook tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   webhook.endpoint         — direct tenant_id
--   webhook.subscription     — joins via endpoint_id → webhook.endpoint.tenant_id
--   webhook.delivery         — joins via subscription_id → webhook.subscription → endpoint
--   webhook.delivery_attempt — joins via delivery_id → webhook.delivery → subscription → endpoint

-- webhook.endpoint
ALTER TABLE webhook.endpoint ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook.endpoint FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook.endpoint;
CREATE POLICY tenant_isolation ON webhook.endpoint
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- webhook.subscription — join via endpoint_id
ALTER TABLE webhook.subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook.subscription FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook.subscription;
CREATE POLICY tenant_isolation ON webhook.subscription
  USING (EXISTS (
    SELECT 1 FROM webhook.endpoint e
    WHERE e.endpoint_id = subscription.endpoint_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM webhook.endpoint e
    WHERE e.endpoint_id = subscription.endpoint_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- webhook.delivery — chain subscription_id -> subscription -> endpoint
ALTER TABLE webhook.delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook.delivery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook.delivery;
CREATE POLICY tenant_isolation ON webhook.delivery
  USING (EXISTS (
    SELECT 1 FROM webhook.subscription s
    JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
    WHERE s.subscription_id = delivery.subscription_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM webhook.subscription s
    JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
    WHERE s.subscription_id = delivery.subscription_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- webhook.delivery_attempt — chain delivery_id -> delivery -> subscription -> endpoint
ALTER TABLE webhook.delivery_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook.delivery_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON webhook.delivery_attempt;
CREATE POLICY tenant_isolation ON webhook.delivery_attempt
  USING (EXISTS (
    SELECT 1 FROM webhook.delivery d
    JOIN webhook.subscription s ON s.subscription_id = d.subscription_id
    JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
    WHERE d.delivery_id = delivery_attempt.delivery_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM webhook.delivery d
    JOIN webhook.subscription s ON s.subscription_id = d.subscription_id
    JOIN webhook.endpoint e ON e.endpoint_id = s.endpoint_id
    WHERE d.delivery_id = delivery_attempt.delivery_id
      AND e.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
