-- Migration 003: Tenant-BYOK governance SKU for AI Gateway.
-- Per docs/v3.1/prd/Tenant-BYOK-AI-Keys.md §5.1 FR-BYOK-9 and AC-4.
--
-- Adds ai-gateway.completion.governance — a flat per-call SKU that bills
-- the governance, audit, policy, and soft-cap surface for AI completions.
-- Emitted UNCONDITIONALLY by every completion. The companion token SKUs
-- (ai-gateway.complete / ai-gateway.stream) are suppressed by the meter
-- ingest worker when the completion's audit payload carries
-- credential_source='tenant' (BYOK calls bill on the customer's provider
-- invoice, not ours).
--
-- Forward-only; sha256-tracked. ON CONFLICT DO NOTHING for idempotency.

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6a-2026q1', 'ai-gateway.completion.governance', 'call', 'flat_per_call', 0.0001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

COMMENT ON COLUMN meter.pricing_rate.sku
  IS 'Per P6A+BYOK: ai-gateway.completion.governance is emitted on every call; ai-gateway.complete/stream are suppressed for tenant-BYOK completions.';
