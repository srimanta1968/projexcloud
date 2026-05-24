-- Migration 005: seed P7 SKU pricing rates (G-2 / OC-1).
-- Per docs/v3.1/prd/P7-Field-Hyperscale.md §5.1-5.9 SKU rows.
-- Forward-only; sha256-tracked by migration-runner. All INSERTs are
-- ON CONFLICT DO NOTHING so re-runs are safe.
--
-- ============================================================
-- IMPORTANT — These are SAMPLE DEFAULTS for dev/staging.
-- ============================================================
-- These rows seed `meter.pricing_catalog` + `meter.pricing_rate` so the
-- gate has *something* to look up the moment a P7 endpoint goes live.
-- They are NOT the production rate card — the Projexlight Admin UI (to
-- be built) will let an authorized admin override per-SKU rates, create
-- a new catalog version, and promote it via the standard catalog
-- versioning workflow (status='draft' -> 'active' -> 'retired').
--
-- Until that UI ships, treat these defaults as a starting point only.
-- Customer invoices generated against this catalog in production
-- should be sanity-checked before being sent.
--
-- Doctrine OC-1: every billable SDK method ships with @meter() AND a
-- registered rate. Without this seed, every P7 endpoint that the meter
-- gate hits will fail rate lookup and either deny (hard mode) or skip
-- billing (soft mode) — either way the customer invoice is wrong.

-- ---------------------------------------------------------------------------
-- Step 1: ensure the platform P7 catalog exists.
-- ---------------------------------------------------------------------------
-- A single 'platform-p7-2026q3' catalog holds every P7 rate. Future
-- price revisions ship as a new catalog version (status='draft' until
-- promoted), keeping the historical rates immutable for billing audit.
INSERT INTO meter.pricing_catalog (catalog_id, version, status, effective_from, created_by)
VALUES ('platform-p7-2026q3', 1, 'active', now(), 'migration:005_p7_skus')
ON CONFLICT (catalog_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 2: insert P7 SKU rates.
-- ---------------------------------------------------------------------------
-- Mode semantics — see migration 002_p6a_skus.sql for the full reference.
-- All prices in USD.

-- sdk-storm (PRD §5.1) — per-bbox overlay query flat per call.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p7-2026q3', 'storm.overlay.query', 'call', 'flat_per_call', 0.002)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-dispatch (PRD §5.2) — queue enqueue cheap, route optimization tiered.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p7-2026q3', 'dispatch.queue.enqueue', 'call', 'tiered_per_call',
    '[{"upto": 100000, "price": 0}, {"upto": null, "price": 0.0001}]'::jsonb),
  ('platform-p7-2026q3', 'dispatch.route.optimize', 'call', 'tiered_per_call',
    '[{"upto": 1000, "price": 0}, {"upto": 10000, "price": 0.05}, {"upto": null, "price": 0.10}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-assignment (PRD §5.3) — flat per assignment.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p7-2026q3', 'assignment.assign', 'call', 'flat_per_call', 0.001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-lead-scoring (PRD §5.4) — tiered score + next-best-action.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p7-2026q3', 'lead-scoring.score', 'call', 'tiered_per_call',
    '[{"upto": 10000, "price": 0}, {"upto": null, "price": 0.0005}]'::jsonb),
  ('platform-p7-2026q3', 'lead-scoring.next-action', 'call', 'tiered_per_call',
    '[{"upto": 1000, "price": 0}, {"upto": null, "price": 0.005}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-evidence (PRD §5.5) — chain-of-custody linchpin. capture per-GB,
-- legal-export per-bundle, shred per-blob. These rates are placeholder;
-- evidence pricing typically lands as a customer-negotiated rate card
-- because of jurisdictional storage + chain-of-custody guarantees.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p7-2026q3', 'evidence.capture',              'GB',     'per_unit',      0.05),
  ('platform-p7-2026q3', 'evidence.legal-export.generate', 'export', 'flat_per_call', 5.00),
  ('platform-p7-2026q3', 'evidence.shred',                'blob',   'per_unit',      0.001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-diagnostic-telemetry (PRD §5.6) — crash + session replay flat.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p7-2026q3', 'diagnostic.crash.report',          'call', 'flat_per_call', 0.0001),
  ('platform-p7-2026q3', 'diagnostic.session-replay.event',  'call', 'flat_per_call', 0.00001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- hdk-measure + hdk-watermark (PRD §5.9) — server anchor writes flat.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p7-2026q3', 'hdk-measure.captured',  'call', 'flat_per_call', 0.0005),
  ('platform-p7-2026q3', 'hdk-watermark.applied', 'call', 'flat_per_call', 0.001)
ON CONFLICT (catalog_id, sku) DO NOTHING;
