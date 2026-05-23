-- Migration 003: Row-Level Security (RLS) for sdk-media tenant-scoped tables.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Closes OC-8 (defense-in-depth multi-tenant isolation). The session GUC
-- `app.tenant_id` is set per-request by dataService.withTenant(...).
--
-- Tables:
--   media.blob          — direct tenant_id column
--   media.signed_url    — joins through blob_id → media.blob.tenant_id
--   media.transcode_job — joins through blob_id → media.blob.tenant_id

-- media.blob — direct tenant_id
ALTER TABLE media.blob ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.blob FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media.blob;
CREATE POLICY tenant_isolation ON media.blob
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- media.signed_url — join via blob_id
ALTER TABLE media.signed_url ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.signed_url FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media.signed_url;
CREATE POLICY tenant_isolation ON media.signed_url
  USING (EXISTS (
    SELECT 1 FROM media.blob b
    WHERE b.blob_id = signed_url.blob_id
      AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM media.blob b
    WHERE b.blob_id = signed_url.blob_id
      AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));

-- media.transcode_job — join via blob_id
ALTER TABLE media.transcode_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE media.transcode_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON media.transcode_job;
CREATE POLICY tenant_isolation ON media.transcode_job
  USING (EXISTS (
    SELECT 1 FROM media.blob b
    WHERE b.blob_id = transcode_job.blob_id
      AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM media.blob b
    WHERE b.blob_id = transcode_job.blob_id
      AND b.tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  ));
