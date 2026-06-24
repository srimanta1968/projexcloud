-- Additive fix: meter.pricing_rate.updated_at
--
-- upsertPricingRate (src/services/catalogAdmin.ts) writes `updated_at = now()`
-- on ON CONFLICT and RETURNs it, but 001_init_meter.sql never created the
-- column. Every rate upsert (including the pricing-catalog seeds) therefore
-- failed with: column "updated_at" of relation "pricing_rate" does not exist.
-- Forward-only, idempotent — backfills existing rows via the DEFAULT.
ALTER TABLE meter.pricing_rate
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
