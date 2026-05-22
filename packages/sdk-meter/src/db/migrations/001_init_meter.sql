-- Migration 001: sdk-meter canonical schema per P1-Foundation-Spine §9.1.
-- Auto-applied by @projexlight/migration-runner.
-- Tables (Admin pool): meter.pricing_catalog, meter.pricing_rate,
-- meter.quota_policy, meter.usage_ledger_day. ClickHouse rollups (§9.3) and
-- Kafka topic (§9.2) are operational concerns owned by stream processors.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS meter;

CREATE TABLE IF NOT EXISTS meter.pricing_catalog (
  catalog_id      TEXT PRIMARY KEY,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','active','retired')),
  effective_from  TIMESTAMPTZ,
  effective_to    TIMESTAMPTZ,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX IF NOT EXISTS pricing_catalog_status_idx ON meter.pricing_catalog (status, effective_from);

CREATE TABLE IF NOT EXISTS meter.pricing_rate (
  rate_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_id   TEXT NOT NULL REFERENCES meter.pricing_catalog(catalog_id) ON DELETE RESTRICT,
  sku          TEXT NOT NULL,
  unit         TEXT NOT NULL
                 CHECK (unit IN ('call','byte','doc','token','GB-mo')),
  mode         TEXT NOT NULL
                 CHECK (mode IN ('flat_per_call','tiered_per_call','passthrough_plus_margin',
                                 'per_unit','bundled_subscription','free_internal')),
  tiers        JSONB,
  price        NUMERIC(18,8),
  margin_pct   NUMERIC(5,2),
  currency     CHAR(3) NOT NULL DEFAULT 'USD',
  UNIQUE (catalog_id, sku)
);

CREATE INDEX IF NOT EXISTS pricing_rate_sku_idx ON meter.pricing_rate (sku);

CREATE TABLE IF NOT EXISTS meter.quota_policy (
  policy_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID,
  sku              TEXT NOT NULL,
  soft_cap         BIGINT,
  hard_cap         BIGINT,
  "window"         TEXT NOT NULL
                     CHECK ("window" IN ('minute','hour','day','month')),
  action_on_soft   TEXT NOT NULL DEFAULT 'warn'
                     CHECK (action_on_soft IN ('warn','downgrade','throttle')),
  active_from      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quota_lookup_idx ON meter.quota_policy (COALESCE(tenant_id::text,''), sku, "window");

CREATE TABLE IF NOT EXISTS meter.usage_ledger_day (
  tenant_id        UUID NOT NULL,
  day              DATE NOT NULL,
  total_units      JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_count      BIGINT NOT NULL DEFAULT 0,
  prev_hash        BYTEA,
  entry_hash       BYTEA NOT NULL,
  audit_entry_id   UUID,
  finalized_at     TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, day)
);

CREATE INDEX IF NOT EXISTS ledger_day_audit_idx ON meter.usage_ledger_day (audit_entry_id);

COMMENT ON TABLE meter.pricing_catalog IS 'Versioned pricing catalogs per P1-Foundation-Spine §9.1.';
COMMENT ON TABLE meter.pricing_rate IS 'Concrete rate row per SKU per catalog.';
COMMENT ON TABLE meter.quota_policy IS 'Per-tenant caps; soft caps active P4, hard caps active P7. P1 = emit-only.';
COMMENT ON TABLE meter.usage_ledger_day IS 'Hash-chained per-(tenant,day) rollup; anchored in audit.entry for /billing/verify.';
