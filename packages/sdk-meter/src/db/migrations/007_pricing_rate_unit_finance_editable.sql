-- meter.pricing_rate.unit — free-form billing unit (no product-limiting enum).
--
-- ProjexCloud is a horizontal SDK: customers bill ANY product in ANY unit
-- (per-acre, per-patient-encounter, GB/month, kWh, m³, per-1k-tokens, ...). A
-- fixed enum can never anticipate every customer's billing model and would block
-- legitimate products. Per PRD P4 FR-BIL-1, the P1/P4 data model (PRICING_RATE.unit
-- : string), and ProjexLight FT-1005 / TK-3220 (rates are "Finance-editable"),
-- `unit` is a descriptive string. We therefore DROP the original enumerated CHECK
-- (call|byte|doc|token|GB-mo, widened ad hoc in 003/005) entirely.
--
-- The only guard kept is non-empty / non-whitespace: an empty unit is never a
-- valid billing unit, so this is data integrity, not a product limitation. Typo
-- protection (e.g. 'GiB') belongs in the Finance pricing UI, not a DB enum that
-- would also reject valid customer units.
--
-- NOTE: `mode` intentionally stays an enum (see 001 + the rating engine). The
-- sdk-billing invoice generator (TK-3220) only computes the 6 canonical pricing
-- modes; an unknown mode would silently misprice an invoice. `unit` carries no
-- such rating semantics — it is a multiplier label — so it is safe to leave open.
-- Forward-only, idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pricing_rate_unit_check'
       AND conrelid = 'meter.pricing_rate'::regclass
  ) THEN
    ALTER TABLE meter.pricing_rate DROP CONSTRAINT pricing_rate_unit_check;
  END IF;

  ALTER TABLE meter.pricing_rate
    ADD CONSTRAINT pricing_rate_unit_check CHECK (btrim(unit) <> '');
END $$;
