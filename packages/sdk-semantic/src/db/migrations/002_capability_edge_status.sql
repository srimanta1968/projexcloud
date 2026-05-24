-- Migration 002: add status column to capability_graph_edge so soft-deletion
-- (e.g., mcp-server disabled) is auditable without losing history.

ALTER TABLE semantic.capability_graph_edge
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','deprecated','retired'));

CREATE INDEX IF NOT EXISTS semantic_capability_active_idx
  ON semantic.capability_graph_edge (object_type_id)
  WHERE status = 'active';
