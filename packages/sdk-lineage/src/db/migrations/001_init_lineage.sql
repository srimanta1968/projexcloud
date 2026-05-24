-- Migration 001: sdk-lineage canonical schema (G8 closer) per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §9.
-- Auto-applied by @projexlight/migration-runner.
--
-- Closes Gate G8: in-pool subgraphs answer chain queries in ≤50ms;
-- cross-pool edges flow through cross_pool_projection_queue and land
-- in Iceberg warehouse.cross_pool_lineage within 5min (drained by
-- services/lineage-projector).

CREATE SCHEMA IF NOT EXISTS lineage;

-- ---------------------------------------------------------------------------
-- lineage.node — one row per traced entity (field, record, blob, etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage.node (
  node_id     TEXT PRIMARY KEY,
  -- Owning pool — same column appears on edges so cross-pool detection
  -- is a single equality check on emit (no JOIN needed).
  pool_index  TEXT NOT NULL DEFAULT 'default',
  kind        TEXT NOT NULL
                CHECK (kind IN ('field','record','blob','agent-output','recommendation','model')),
  -- What this node represents — e.g. ref_kind='parsing.extracted_field',
  -- ref_id='{field_id}'. Composite identity unique per (ref_kind, ref_id).
  ref_kind    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  tenant_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lineage_node_ref_uq    ON lineage.node (ref_kind, ref_id);
CREATE INDEX        IF NOT EXISTS lineage_node_tenant   ON lineage.node (tenant_id, created_at DESC);
CREATE INDEX        IF NOT EXISTS lineage_node_kind_idx ON lineage.node (kind);

-- ---------------------------------------------------------------------------
-- lineage.edge — in-pool directed edges between nodes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lineage.edge (
  edge_id            TEXT PRIMARY KEY,
  from_node_id       TEXT NOT NULL REFERENCES lineage.node(node_id) ON DELETE CASCADE,
  to_node_id         TEXT NOT NULL REFERENCES lineage.node(node_id) ON DELETE CASCADE,
  edge_kind          TEXT NOT NULL
                       CHECK (edge_kind IN ('extracted_from','derived_from','merged_from','scored_by','translated_by')),
  producer_sdk       TEXT NOT NULL,
  producer_event_id  TEXT,
  trace_id           TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT lineage_edge_not_self CHECK (from_node_id <> to_node_id)
);

CREATE INDEX IF NOT EXISTS lineage_edge_to_idx       ON lineage.edge (to_node_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lineage_edge_from_idx     ON lineage.edge (from_node_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS lineage_edge_trace_idx    ON lineage.edge (trace_id);
CREATE INDEX IF NOT EXISTS lineage_edge_producer_idx ON lineage.edge (producer_sdk, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- lineage.cross_pool_projection_queue — items the worker emits to Iceberg.
-- ---------------------------------------------------------------------------
-- Edges where node.pool_index of from != to are inserted here on emit
-- alongside the lineage.edge row, then drained by services/lineage-projector
-- which writes to Iceberg warehouse.cross_pool_lineage and flips state.
CREATE TABLE IF NOT EXISTS lineage.cross_pool_projection_queue (
  queue_id       TEXT PRIMARY KEY,
  edge_id        TEXT NOT NULL REFERENCES lineage.edge(edge_id) ON DELETE CASCADE,
  source_pool    TEXT NOT NULL,
  target_pool    TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','projected','failed')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error     TEXT,
  enqueued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at   TIMESTAMPTZ,

  CONSTRAINT lineage_proj_pools_differ CHECK (source_pool <> target_pool)
);

-- Worker drains pending rows in enqueued_at order with SELECT … FOR UPDATE
-- SKIP LOCKED for safe horizontal scaling (per services/lineage-projector
-- design — multiple worker pods concurrent).
CREATE INDEX IF NOT EXISTS lineage_proj_pending_idx
  ON lineage.cross_pool_projection_queue (enqueued_at)
  WHERE state = 'pending';

CREATE INDEX IF NOT EXISTS lineage_proj_edge_idx
  ON lineage.cross_pool_projection_queue (edge_id);

CREATE INDEX IF NOT EXISTS lineage_proj_failed_idx
  ON lineage.cross_pool_projection_queue (enqueued_at DESC)
  WHERE state = 'failed';

COMMENT ON SCHEMA lineage IS 'sdk-lineage (P6B §5.6 · G8 closer). In-pool subgraph + cross-pool projection queue. Iceberg warehouse.cross_pool_lineage is hydrated by services/lineage-projector.';
