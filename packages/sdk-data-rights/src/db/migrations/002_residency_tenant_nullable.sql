-- Migration 002: relax data_rights.person_pool_residency.tenant_id to NULL-able.
-- Prod fix: platform-scoped data (sdk-device person_link) has no tenant_id;
-- the 001 sentinel '00000000-...-000' approach collapsed every platform-
-- scoped residency for the same (person, pool) into one row across the
-- entire fleet, breaking DSAR fan-out tenancy semantics.
--
-- The UNIQUE constraint can't span (col, col, NULL) because Postgres treats
-- NULLs as distinct in UNIQUE indexes. Split into two partial indexes so
-- (person, pool, NULL) is at most one row AND (person, pool, tenant) is at
-- most one row per non-NULL tenant.

ALTER TABLE data_rights.person_pool_residency
  ALTER COLUMN tenant_id DROP NOT NULL;

-- Drop the original UNIQUE (auto-generated name conventions vary by Postgres
-- version; query pg_constraint to find and drop). The constraint was created
-- inline in 001 — discover its name dynamically.
DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'data_rights.person_pool_residency'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(person_id, pool_index, tenant_id)%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE data_rights.person_pool_residency DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

-- Partial UNIQUE: at most one row per (person, pool) when tenant_id is NULL
-- (platform-scoped data) AND at most one row per (person, pool, tenant) when
-- it's set (tenant-scoped data).
CREATE UNIQUE INDEX IF NOT EXISTS residency_uniq_with_tenant
  ON data_rights.person_pool_residency (person_id, pool_index, tenant_id)
  WHERE tenant_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS residency_uniq_no_tenant
  ON data_rights.person_pool_residency (person_id, pool_index)
  WHERE tenant_id IS NULL;
