-- Migration 002: seed P6A SKU pricing rates (G-2 / OC-1).
-- Per docs/v3.1/prd/P6A-AI-Isolation-MCP.md §5.1-5.5 SKU rows.
-- Forward-only; sha256-tracked by migration-runner. All INSERTs are
-- ON CONFLICT DO NOTHING so re-runs are safe.
--
-- Doctrine OC-1: every billable SDK method ships with @meter() AND a
-- registered rate. Without this seed, every P6A endpoint that the meter
-- gate hits will fail rate lookup and either deny (hard mode) or skip
-- billing (soft mode) — either way the customer invoice is wrong.

-- ---------------------------------------------------------------------------
-- Step 1: ensure the platform P6A catalog exists.
-- ---------------------------------------------------------------------------
-- A single 'platform-p6a-2026q1' catalog holds every P6A rate. Future
-- price revisions ship as a new catalog version (status='draft' until
-- promoted), keeping the historical rates immutable for billing audit.
INSERT INTO meter.pricing_catalog (catalog_id, version, status, effective_from, created_by)
VALUES ('platform-p6a-2026q1', 1, 'active', now(), 'migration:002_p6a_skus')
ON CONFLICT (catalog_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 2: insert P6A SKU rates.
-- ---------------------------------------------------------------------------
-- Mode semantics (CHECK constraint in pricing_rate):
--   * passthrough_plus_margin → price=NULL, margin_pct set, vendor cost
--                                emitted as units (PRD §5.1 FR-AGW-4).
--   * tiered_per_call         → price=NULL, tiers JSONB (e.g. first 1k free,
--                                next 10k @ price A, beyond @ price B).
--   * flat_per_call           → price set, no tiers/margin.
--   * per_unit                → price per emitted unit (call/doc/etc.).
--
-- All currencies USD; tenant-specific overrides land in a separate table
-- (P4 § future). UNIQUE (catalog_id, sku) makes these idempotent.

-- sdk-ai-gateway (PRD §5.1)
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, margin_pct) VALUES
  ('platform-p6a-2026q1', 'ai-gateway.complete', 'token', 'passthrough_plus_margin', 15.00),
  ('platform-p6a-2026q1', 'ai-gateway.stream',   'token', 'passthrough_plus_margin', 15.00)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-agent-runtime (PRD §5.2) — tiered to keep early-stage agent dev affordable
-- while pricing scales with usage. First 1k calls/month free, then $0.001/call.
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p6a-2026q1', 'agent-runtime.run.start',
    'call', 'tiered_per_call',
    '[{"upto": 1000, "price": 0}, {"upto": null, "price": 0.001}]'::jsonb),
  ('platform-p6a-2026q1', 'agent-runtime.tool.invoke',
    'call', 'tiered_per_call',
    '[{"upto": 10000, "price": 0}, {"upto": null, "price": 0.0005}]'::jsonb),
  ('platform-p6a-2026q1', 'agent-runtime.replay',
    'call', 'tiered_per_call',
    '[{"upto": 100, "price": 0}, {"upto": null, "price": 0.01}]'::jsonb),
  ('platform-p6a-2026q1', 'agent-runtime.capability-token.mint',
    'call', 'tiered_per_call',
    '[{"upto": 100000, "price": 0}, {"upto": null, "price": 0.00001}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-trace (PRD §5.3) — flat per query; export at higher per-bundle price
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6a-2026q1', 'trace.query',       'call', 'flat_per_call', 0.0001),
  ('platform-p6a-2026q1', 'trace.export.pdf',  'call', 'flat_per_call', 0.05),
  ('platform-p6a-2026q1', 'trace.export.json', 'call', 'flat_per_call', 0.01)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-mcp-bridge (PRD §5.4) — external MCP call passes vendor cost through
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, margin_pct) VALUES
  ('platform-p6a-2026q1', 'mcp.tool.invoke', 'call', 'passthrough_plus_margin', 15.00)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6a-2026q1', 'mcp.server.register', 'call', 'flat_per_call', 0.10)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-taxonomy (PRD §5.2 taxonomy block) — cheap lookups; bundled in spirit
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6a-2026q1', 'taxonomy.schema.lookup',   'call', 'flat_per_call', 0.00001),
  ('platform-p6a-2026q1', 'taxonomy.template.lookup', 'call', 'flat_per_call', 0.00001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- connector-github (PRD §5.5) — per-record sync + per-call passthrough
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6a-2026q1', 'connector.github.sync.record', 'call', 'per_unit',       0.00005),
  ('platform-p6a-2026q1', 'connector.github.api.call',    'call', 'flat_per_call',  0.0001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

COMMENT ON TABLE meter.pricing_rate
  IS 'Per-SKU pricing. P1 schema; P6A seeds via migration 002_p6a_skus.sql.';
