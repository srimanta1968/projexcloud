-- Migration 003: seed P6B SKU pricing rates (G-2 / OC-1).
-- Per docs/v3.1/prd/P6B-Knowledge-Semantic.md §5.1-5.8 SKU rows.
-- Forward-only; sha256-tracked by migration-runner. All INSERTs are
-- ON CONFLICT DO NOTHING so re-runs are safe.
--
-- Doctrine OC-1: every billable SDK method ships with @meter() AND a
-- registered rate. Without this seed, every P6B endpoint that the meter
-- gate hits will fail rate lookup and either deny (hard mode) or skip
-- billing (soft mode) — either way the customer invoice is wrong.

-- ---------------------------------------------------------------------------
-- Step 1: ensure the platform P6B catalog exists.
-- ---------------------------------------------------------------------------
-- A single 'platform-p6b-2026q2' catalog holds every P6B rate. Future
-- price revisions ship as a new catalog version (status='draft' until
-- promoted), keeping the historical rates immutable for billing audit.
INSERT INTO meter.pricing_catalog (catalog_id, version, status, effective_from, created_by)
VALUES ('platform-p6b-2026q2', 1, 'active', now(), 'migration:003_p6b_skus')
ON CONFLICT (catalog_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Step 2: insert P6B SKU rates.
-- ---------------------------------------------------------------------------
-- Mode semantics — see migration 002_p6a_skus.sql for the full reference.

-- sdk-knowledge-rag (PRD §5.1) — index per-MB, embed pass-through, retrieve tiered
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'rag.index.document', 'MB', 'per_unit', 0.001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, margin_pct) VALUES
  ('platform-p6b-2026q2', 'rag.embed', 'token', 'passthrough_plus_margin', 15.00)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p6b-2026q2', 'rag.retrieve', 'call', 'tiered_per_call',
    '[{"upto": 10000, "price": 0}, {"upto": null, "price": 0.0001}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-parsing (PRD §5.2) — per-document, complexity tiered
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'parsing.document.parse', 'document', 'per_unit', 0.05),
  ('platform-p6b-2026q2', 'parsing.re-extract',     'document', 'per_unit', 0.02)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-conversation (PRD §5.3) — tiered per message; flat handoff
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p6b-2026q2', 'conversation.message.send', 'call', 'tiered_per_call',
    '[{"upto": 10000, "price": 0}, {"upto": null, "price": 0.0002}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'conversation.handoff', 'call', 'flat_per_call', 0.01)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-recommendation (PRD §5.4) — tiered suggest; per-training-run
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p6b-2026q2', 'recommendation.suggest', 'call', 'tiered_per_call',
    '[{"upto": 100000, "price": 0}, {"upto": null, "price": 0.00005}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'recommendation.train', 'run', 'per_unit', 0.50)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-analytics (PRD §5.5) — rollup per-call; lakehouse per-GB scanned
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'analytics.rollup.query',    'call', 'flat_per_call', 0.001),
  ('platform-p6b-2026q2', 'analytics.lakehouse.query', 'GB',   'per_unit',      0.05)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-lineage (PRD §5.6 · G8 closer) — write is cheap, queries flat
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'lineage.edge.write',        'call', 'flat_per_call', 0.00001),
  ('platform-p6b-2026q2', 'lineage.chain.query',       'call', 'flat_per_call', 0.0005),
  ('platform-p6b-2026q2', 'lineage.cross-pool.query',  'call', 'flat_per_call', 0.005)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- sdk-semantic (PRD §5.7 · G9 closer) — tiered intent/policy; flat ontology
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, tiers) VALUES
  ('platform-p6b-2026q2', 'semantic.intent.plan', 'call', 'tiered_per_call',
    '[{"upto": 10000, "price": 0}, {"upto": null, "price": 0.0005}]'::jsonb),
  ('platform-p6b-2026q2', 'semantic.policy.evaluate', 'call', 'tiered_per_call',
    '[{"upto": 1000000, "price": 0}, {"upto": null, "price": 0.000005}]'::jsonb)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'semantic.ontology.register', 'call', 'flat_per_call', 0.10)
ON CONFLICT (catalog_id, sku) DO NOTHING;

-- connector-snowflake (PRD §5.8) — passthrough on query bytes, per-row on sync
INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, margin_pct) VALUES
  ('platform-p6b-2026q2', 'snowflake.query', 'byte', 'passthrough_plus_margin', 15.00)
ON CONFLICT (catalog_id, sku) DO NOTHING;

INSERT INTO meter.pricing_rate (catalog_id, sku, unit, mode, price) VALUES
  ('platform-p6b-2026q2', 'snowflake.sync.row', 'row', 'per_unit', 0.000001)
ON CONFLICT (catalog_id, sku) DO NOTHING;

COMMENT ON TABLE meter.pricing_rate
  IS 'Per-SKU pricing. P1 schema; P6A seeds via 002_p6a_skus.sql; P6B seeds via 003_p6b_skus.sql.';
