-- Migration 002: sdk-crm — configurable funnel stages, richer deal fields,
-- stage-aging. P14 · E4 (TK-3628). Auto-applied by the migration runner at boot.
--
-- ADDITIVE + idempotent: CREATE TABLE / ADD COLUMN ... IF NOT EXISTS only, so
-- existing crm.deal data is preserved. Parity with projex_crm funnel_stages +
-- deals.current_stage_id — re-homed onto the tenant-scoped crm schema.
--
-- Funnel stages become CONFIGURABLE rows (crm.funnel_stage), not the hardcoded
-- `stage` CHECK enum from 001. The original `stage` column is kept for
-- back-compat; new work references funnel_stage_id.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- crm.funnel_stage
-- Per-tenant configurable pipeline stage (parity: funnel_stages).
CREATE TABLE IF NOT EXISTS crm.funnel_stage (
  stage_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  description  TEXT,
  criteria     TEXT,
  probability  NUMERIC(5,2),
  is_default   BOOLEAN NOT NULL DEFAULT false,
  is_terminal  BOOLEAN NOT NULL DEFAULT false,
  is_won       BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS crm_funnel_stage_tenant_idx
  ON crm.funnel_stage (tenant_id, sort_order);

-- ---------------------------------------------------------------- crm.deal enrichment
-- Configurable-stage link (nullable; the 001 `stage` enum stays for back-compat).
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS funnel_stage_id UUID
  REFERENCES crm.funnel_stage(stage_id) ON DELETE SET NULL;

-- Richer deal fields (TK-3628).
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS priority TEXT
  CHECK (priority IN ('low','medium','high','critical'));
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS fit TEXT
  CHECK (fit IN ('poor','moderate','strong','ideal'));
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS pain TEXT;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS impact TEXT;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS outcome TEXT;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS stakeholders JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS decision_date DATE;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS offer_version TEXT;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS forecast TEXT
  CHECK (forecast IN ('omitted','pipeline','best_case','commit','closed'));

-- Stage-aging: when the deal entered its current stage / last moved. Powers
-- stale-deal detection (TK-3629, idle > 5 business days).
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS entered_stage_at TIMESTAMPTZ;
ALTER TABLE crm.deal ADD COLUMN IF NOT EXISTS last_stage_change_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS crm_deal_funnel_stage_idx
  ON crm.deal (funnel_stage_id);
-- Stale detection scan: oldest-in-stage first, per tenant.
CREATE INDEX IF NOT EXISTS crm_deal_stage_aging_idx
  ON crm.deal (tenant_id, last_stage_change_at);

COMMENT ON TABLE  crm.funnel_stage            IS 'Configurable pipeline stage (parity: funnel_stages). Replaces the hardcoded deal.stage enum for new work.';
COMMENT ON COLUMN crm.deal.funnel_stage_id    IS 'Configurable stage link (nullable; 001 stage enum kept for back-compat).';
COMMENT ON COLUMN crm.deal.last_stage_change_at IS 'Stage-aging anchor for stale-deal detection (TK-3629).';
