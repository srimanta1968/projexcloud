-- Migration 002: Row-Level Security (RLS) for sdk-search tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). Session GUC
-- `app.tenant_id` set per-request by dataService.withTenant(...).
--
-- Tables:
--   search.index_definition — direct tenant_id
--   search.index_partition  — joins via index_def_id → search.index_definition.tenant_id
--   search.saved_query      — direct tenant_id

-- search.index_definition
ALTER TABLE search.index_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.index_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search.index_definition;
CREATE POLICY tenant_isolation ON search.index_definition
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- search.index_partition — join via index_def_id
ALTER TABLE search.index_partition ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.index_partition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search.index_partition;
CREATE POLICY tenant_isolation ON search.index_partition
  USING (EXISTS (
    SELECT 1 FROM search.index_definition d
    WHERE d.index_def_id = index_partition.index_def_id
      AND d.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM search.index_definition d
    WHERE d.index_def_id = index_partition.index_def_id
      AND d.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- search.saved_query
ALTER TABLE search.saved_query ENABLE ROW LEVEL SECURITY;
ALTER TABLE search.saved_query FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON search.saved_query;
CREATE POLICY tenant_isolation ON search.saved_query
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
