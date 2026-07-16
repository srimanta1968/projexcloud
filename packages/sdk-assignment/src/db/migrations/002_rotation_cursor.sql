-- Migration 002: sdk-assignment — round-robin / fair-share rotation cursor.
-- P14 · E5 (TK, EP-335). Auto-applied by the migration runner at boot.
--
-- ADDITIVE: a NEW assignment.rotation_cursor table only. assignment.assignment /
-- .territory / .workload are untouched, so existing behavior is unchanged when
-- no rotation strategy is used. Parity with projex_crm user_pool_assignment
-- (a last-assigned pointer per pool), re-homed + tenant-scoped.
--
-- Persists a "last-assigned pointer" per (tenant, territory-or-pool, strategy)
-- so next-in-line selection is O(1) and never scans assignment history.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assignment.rotation_cursor (
  cursor_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  -- Territory-scoped (FK is TEXT — matches assignment.territory.territory_id),
  -- or NULL for a logical pool identified by pool_key.
  territory_id             TEXT REFERENCES assignment.territory(territory_id) ON DELETE CASCADE,
  pool_key                 TEXT NOT NULL DEFAULT 'default',
  strategy                 TEXT NOT NULL DEFAULT 'round_robin'
                             CHECK (strategy IN ('round_robin','fair_share')),
  last_assigned_persona_id UUID,
  rotation_index           INTEGER NOT NULL DEFAULT 0 CHECK (rotation_index >= 0),
  last_assigned_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One cursor per (tenant, territory-or-pool, strategy). COALESCE folds pool-based
-- rows (NULL territory) into a stable key, giving a single conflict target for
-- the concurrency-safe atomic advance:
--   INSERT ... ON CONFLICT (...) DO UPDATE
--     SET rotation_index = assignment.rotation_cursor.rotation_index + 1,
--         last_assigned_persona_id = EXCLUDED.last_assigned_persona_id,
--         last_assigned_at = now(), updated_at = now()
--   RETURNING rotation_index;
CREATE UNIQUE INDEX IF NOT EXISTS assignment_rotation_cursor_scope_idx
  ON assignment.rotation_cursor (tenant_id, COALESCE(territory_id, ''), pool_key, strategy);
CREATE INDEX IF NOT EXISTS assignment_rotation_cursor_tenant_idx
  ON assignment.rotation_cursor (tenant_id);

COMMENT ON TABLE assignment.rotation_cursor IS 'Round-robin/fair-share last-assigned pointer per (tenant, territory-or-pool, strategy). Advanced via atomic ON CONFLICT upsert (EP-335).';
