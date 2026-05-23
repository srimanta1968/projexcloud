-- Migration 003: persistent soft-cap state per FR-BIL-3.
--
-- Replaces the in-memory `InMemorySoftCapStore` Map that lost caps on pod
-- restart AND diverged across replicas. PostgresSoftCapStore reads + writes
-- here; sdk-meter's softCapMiddleware reads here too on every gated call.
--
-- Production swaps for Redis quota structures via registerSoftCapStore() —
-- the table remains the source of truth and is the seed for the Redis warm.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.soft_cap_state (
  tenant_id   UUID NOT NULL,
  sku         TEXT NOT NULL,
  cap         NUMERIC(18, 6) NOT NULL CHECK (cap >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS soft_cap_state_tenant_idx ON billing.soft_cap_state (tenant_id);

-- RLS: callers reading their own caps run under app.tenant_id GUC.
ALTER TABLE billing.soft_cap_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.soft_cap_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.soft_cap_state;
CREATE POLICY tenant_isolation ON billing.soft_cap_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE billing.soft_cap_state IS 'Per-tenant per-SKU soft caps; consulted by sdk-meter on every gated call. Replaces the in-memory dev-only Map.';
