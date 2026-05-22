-- Migration 001: sdk-tenant canonical schema per P2-Identity-Access-DataModel §4.
-- Auto-applied by @projexlight/migration-runner on startup.
-- Tables: tenant.{org, app, reseller, tenant, bu, role_template, fiscal_period, geo_node}.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS tenant;

CREATE TABLE IF NOT EXISTS tenant.org (
  org_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id   UUID REFERENCES tenant.org(org_id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant.app (
  app_id        TEXT PRIMARY KEY,
  org_id        UUID NOT NULL REFERENCES tenant.org(org_id) ON DELETE RESTRICT,
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','sunset','retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant.reseller (
  reseller_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES tenant.org(org_id) ON DELETE RESTRICT,
  brand_name           TEXT NOT NULL,
  cname_host           TEXT,
  support_contact      JSONB NOT NULL DEFAULT '{}'::jsonb,
  commission_rules     JSONB NOT NULL DEFAULT '{}'::jsonb,
  invoice_aggregation  TEXT NOT NULL DEFAULT 'per-tenant'
                         CHECK (invoice_aggregation IN ('per-tenant','consolidated')),
  portfolio_kill_switch BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant.geo_node (
  geo_node_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_geo_node_id UUID REFERENCES tenant.geo_node(geo_node_id) ON DELETE RESTRICT,
  kind               TEXT NOT NULL
                       CHECK (kind IN ('region','country','state','city','locality')),
  code               TEXT,
  name               TEXT NOT NULL,
  residency_class    TEXT NOT NULL DEFAULT 'open'
                       CHECK (residency_class IN ('open','regulated','sovereign'))
);

CREATE INDEX IF NOT EXISTS geo_node_parent_idx ON tenant.geo_node (parent_geo_node_id);

CREATE TABLE IF NOT EXISTS tenant.tenant (
  tenant_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id               TEXT NOT NULL REFERENCES tenant.app(app_id) ON DELETE RESTRICT,
  parent_tenant_id     UUID REFERENCES tenant.tenant(tenant_id) ON DELETE RESTRICT,
  root_tenant_id       UUID,
  reseller_id          UUID REFERENCES tenant.reseller(reseller_id) ON DELETE SET NULL,
  isolation_tier       TEXT NOT NULL DEFAULT 'S'
                         CHECK (isolation_tier IN ('S','P','G')),
  region               TEXT NOT NULL,
  geo_node_id          UUID REFERENCES tenant.geo_node(geo_node_id) ON DELETE SET NULL,
  brand_domain         TEXT,
  admin_pool_index     TEXT,
  app_pool_index       JSONB NOT NULL DEFAULT '{}'::jsonb,
  module_subscriptions TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  status               TEXT NOT NULL DEFAULT 'provisioned'
                         CHECK (status IN ('provisioned','trial','active','suspended','offboarding','offboarded')),
  display_name         TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_parent_idx ON tenant.tenant (parent_tenant_id);
CREATE INDEX IF NOT EXISTS tenant_root_idx   ON tenant.tenant (root_tenant_id);
CREATE INDEX IF NOT EXISTS tenant_reseller_idx ON tenant.tenant (reseller_id);
CREATE INDEX IF NOT EXISTS tenant_app_idx    ON tenant.tenant (app_id, status);

-- Materialize root_tenant_id on insert/update so ancestor queries stay O(1).
CREATE OR REPLACE FUNCTION tenant.materialize_root()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_tenant_id IS NULL THEN
    NEW.root_tenant_id = NEW.tenant_id;
  ELSE
    SELECT COALESCE(t.root_tenant_id, t.tenant_id) INTO NEW.root_tenant_id
      FROM tenant.tenant t WHERE t.tenant_id = NEW.parent_tenant_id;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_materialize_root ON tenant.tenant;
CREATE TRIGGER tenant_materialize_root
  BEFORE INSERT OR UPDATE OF parent_tenant_id ON tenant.tenant
  FOR EACH ROW EXECUTE FUNCTION tenant.materialize_root();

CREATE TABLE IF NOT EXISTS tenant.bu (
  bu_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenant.tenant(tenant_id) ON DELETE CASCADE,
  parent_bu_id   UUID REFERENCES tenant.bu(bu_id) ON DELETE RESTRICT,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  ancestors      TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bu_tenant_idx ON tenant.bu (tenant_id);
CREATE INDEX IF NOT EXISTS bu_parent_idx ON tenant.bu (parent_bu_id);

CREATE TABLE IF NOT EXISTS tenant.role_template (
  role_template_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID REFERENCES tenant.tenant(tenant_id) ON DELETE CASCADE,
  app_id                  TEXT NOT NULL REFERENCES tenant.app(app_id) ON DELETE RESTRICT,
  name                    TEXT NOT NULL,
  parent_role_template_id UUID REFERENCES tenant.role_template(role_template_id) ON DELETE RESTRICT,
  permissions             JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Platform-default templates (tenant_id IS NULL) unique by (app_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS role_template_global_uniq
  ON tenant.role_template (app_id, name) WHERE tenant_id IS NULL;
-- Tenant-override templates unique by (tenant_id, app_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS role_template_tenant_uniq
  ON tenant.role_template (tenant_id, app_id, name) WHERE tenant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS role_template_app_idx ON tenant.role_template (app_id);
CREATE INDEX IF NOT EXISTS role_template_parent_idx ON tenant.role_template (parent_role_template_id);

CREATE TABLE IF NOT EXISTS tenant.fiscal_period (
  fiscal_period_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenant.tenant(tenant_id) ON DELETE CASCADE,
  year_start_month   INT NOT NULL CHECK (year_start_month BETWEEN 1 AND 12),
  base_currency      CHAR(3) NOT NULL DEFAULT 'USD',
  period_kind        TEXT NOT NULL
                       CHECK (period_kind IN ('year','quarter','month','week')),
  label              TEXT NOT NULL,
  starts_at          DATE NOT NULL,
  ends_at            DATE NOT NULL,
  CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS fiscal_tenant_idx ON tenant.fiscal_period (tenant_id, starts_at);

COMMENT ON TABLE tenant.org IS 'Top-level organization. One per platform customer (rare).';
COMMENT ON TABLE tenant.tenant IS 'Per P2-Identity-Access-DataModel §4. Recursive via parent_tenant_id; root_tenant_id materialized for ancestor queries.';
COMMENT ON TABLE tenant.reseller IS 'First-class reseller entity with commission + white-label config.';
COMMENT ON TABLE tenant.geo_node IS 'Region->Country->State->City->Locality tree, separate from pool_index for sub-regional residency.';
COMMENT ON TABLE tenant.role_template IS 'Per-app role registry with inheritance. tenant_id NULL = platform default.';
