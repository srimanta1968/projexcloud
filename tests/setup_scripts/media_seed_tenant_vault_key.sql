-- Seeds an active tenant-tier envelope key for the CURRENT signup-tenant tenant
-- so POST /api/media/upload-url can resolve a vault key ref (FR-MED-1).
--
-- sdk-media.blobService.resolveVaultKeyRef() looks up
--   vault.key WHERE tier='tenant' AND scope_id=<jwt.tenant_id> AND state='active'
-- and throws "No active vault tenant key" (surfaced as 400 VaultKeyMissing) when
-- it is missing. signup-tenant does NOT provision this key, and the sole issuing
-- API (POST /api/vault/keys) cannot be wired as a media dependsOn producer: the
-- runner allows one def per METHOD+ENDPOINT and that single vault/keys def is
-- shared by rotate/shred/encounters which mutate the created key's state. So we
-- seed here, scoped to the run's dynamic tenant via the cache placeholder.
--
-- A tenant-tier key requires a NOT NULL parent of a strictly higher tier
-- (vault.key_check_parent_tier trigger); root is a valid direct parent. The root
-- key is global (no tenant scope), so one shared, idempotent root row is reused
-- across runs as the wrapping parent.

INSERT INTO vault.key (tier, kms_ref, region, state, algorithm)
SELECT 'root', 'kms-media-seed-root', 'us-east-1', 'active', 'AES-256-GCM'
WHERE NOT EXISTS (
  SELECT 1 FROM vault.key WHERE tier = 'root' AND kms_ref = 'kms-media-seed-root'
);

INSERT INTO vault.key (tier, scope_id, parent_key_id, kms_ref, region, state, algorithm)
SELECT 'tenant',
       '{{cache:auth.signup-tenant.response.data.tenant_id}}',
       (SELECT key_id FROM vault.key
          WHERE tier = 'root' AND kms_ref = 'kms-media-seed-root'
          ORDER BY issued_at LIMIT 1),
       'kms-media-seed-tenant',
       'us-east-1', 'active', 'AES-256-GCM'
WHERE NOT EXISTS (
  SELECT 1 FROM vault.key
   WHERE tier = 'tenant'
     AND scope_id = '{{cache:auth.signup-tenant.response.data.tenant_id}}'
     AND state = 'active'
);
