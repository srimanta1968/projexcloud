-- Migration 001: sdk-billing canonical schema per P4-Operational-Billing-DataModel §9.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: billing.{invoice, line_item, dunning_state, reprice_dry_run}
-- Pool: Admin (per tenant) · reads ClickHouse meter rollups
-- FR-BIL-1..8 per PRD §5.6.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS billing;

-- billing.invoice per §9.1
-- catalog_id is the immutable snapshot of meter.pricing_catalog applied at
-- generation time — invoices are reproducible because the catalog is pinned.
-- fiscal_period_id FK to tenant.fiscal_period gives fiscal alignment + currency.
CREATE TABLE IF NOT EXISTS billing.invoice (
  invoice_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  catalog_id          TEXT NOT NULL REFERENCES meter.pricing_catalog(catalog_id) ON DELETE RESTRICT,
  fiscal_period_id    UUID REFERENCES tenant.fiscal_period(fiscal_period_id) ON DELETE SET NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  subtotal            NUMERIC(18,4) NOT NULL DEFAULT 0,
  tax                 NUMERIC(18,4) NOT NULL DEFAULT 0,
  total               NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency            CHAR(3) NOT NULL DEFAULT 'USD',
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','finalized','paid','failed','void')),
  pdf_s3_key          TEXT,
  stripe_invoice_id   TEXT,
  generated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at        TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ
);

-- One finalized invoice per (tenant, period) is the rule; multiple drafts
-- are allowed so re-generation is safe. Partial UNIQUE enforces this.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_tenant_period_finalized_uniq
  ON billing.invoice (tenant_id, period_start, period_end)
  WHERE status IN ('finalized','paid');
CREATE INDEX IF NOT EXISTS invoice_tenant_idx
  ON billing.invoice (tenant_id, period_start DESC);
CREATE INDEX IF NOT EXISTS invoice_status_idx
  ON billing.invoice (status);

-- billing.line_item per §9.1 - per-SKU with full showback dimensions.
-- This table is THE wedge: arbitrary (app, BU, persona-kind, encounter) splits.
CREATE TABLE IF NOT EXISTS billing.line_item (
  line_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES billing.invoice(invoice_id) ON DELETE CASCADE,
  sku            TEXT NOT NULL,
  app_id         TEXT,
  bu_id          TEXT,
  persona_kind   TEXT,
  encounter_id   TEXT,
  units          NUMERIC(18,6) NOT NULL DEFAULT 0,
  rate           NUMERIC(18,8) NOT NULL DEFAULT 0,
  amount         NUMERIC(18,4) NOT NULL DEFAULT 0,
  actor_kind     TEXT
                   CHECK (actor_kind IS NULL OR actor_kind IN ('human','agent','service'))
);

CREATE INDEX IF NOT EXISTS line_invoice_idx
  ON billing.line_item (invoice_id);
CREATE INDEX IF NOT EXISTS line_sku_dims_idx
  ON billing.line_item (sku, app_id, bu_id, persona_kind);

-- billing.dunning_state per §9.1 - workflow state per overdue invoice.
-- workflow_run_id FK loosely references workflow.run; not enforced via REFERENCES
-- because workflow.run may live in a different pool in production.
CREATE TABLE IF NOT EXISTS billing.dunning_state (
  dunning_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES billing.invoice(invoice_id) ON DELETE CASCADE,
  stage             TEXT NOT NULL DEFAULT 'reminder-1'
                      CHECK (stage IN ('reminder-1','reminder-2','final-notice','service-suspend','written-off')),
  workflow_run_id   UUID,
  last_action_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS dunning_invoice_uniq
  ON billing.dunning_state (invoice_id);
CREATE INDEX IF NOT EXISTS dunning_stage_idx
  ON billing.dunning_state (stage, last_action_at);

-- billing.reprice_dry_run per §9.1 - what-if catalog comparison.
CREATE TABLE IF NOT EXISTS billing.reprice_dry_run (
  dry_run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID,
  period_start          DATE NOT NULL,
  period_end            DATE NOT NULL,
  baseline_catalog_id   TEXT NOT NULL REFERENCES meter.pricing_catalog(catalog_id) ON DELETE RESTRICT,
  target_catalog_id     TEXT NOT NULL REFERENCES meter.pricing_catalog(catalog_id) ON DELETE RESTRICT,
  delta_amount          NUMERIC(18,4) NOT NULL DEFAULT 0,
  delta_by_sku          JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reprice_tenant_period_idx
  ON billing.reprice_dry_run (tenant_id, period_start DESC);

COMMENT ON TABLE billing.invoice         IS 'Per P4-DataModel §9.1. catalog_id pin makes invoices reproducible; status enum draft|finalized|paid|failed|void.';
COMMENT ON TABLE billing.line_item       IS 'Per FR-BIL-5. THE wedge: arbitrary (app, BU, persona_kind, encounter) showback splits. actor_kind for agent-vs-human split.';
COMMENT ON TABLE billing.dunning_state   IS 'Per FR-BIL-4. Drives overdue collection via sdk-workflow; stages map to dunning workflow steps.';
COMMENT ON TABLE billing.reprice_dry_run IS 'Per FR-BIL-6. baseline vs target catalog comparison; delta_by_sku per-SKU breakdown.';
