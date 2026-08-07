-- Every tenant needs an active tenant-tier envelope key, and nothing created one.
--
-- resolveVaultKeyRef() (sdk-media/src/services/blobService.ts) requires
--   vault.key WHERE tier='tenant' AND scope_id=<tenant> AND state='active'
-- and POST /api/media/upload-url answers 400 VaultKeyMissing without it. Tenant
-- creation never issued the key: the only thing that ever did was the QA fixture
-- tests/setup_scripts/media_seed_tenant_vault_key.sql, whose own header admits
-- "signup-tenant does NOT provision this key". Fixtures do not run on a deployed
-- stack, so in production EVERY tenant has been missing this key.
--
-- The cost is not one endpoint. Six media and evidence endpoints consume the blob
-- id upload-url issues, so they report as SKIPPED rather than failed — seven
-- endpoints leave a test run with no failure recorded against any of them.
--
-- This migration fixes the EXISTING population. New tenants are covered by
-- vault.ensureTenantKey(), called from resolveVaultKeyRef, so that one function
-- serves both and there is no second mechanism to drift out of agreement.

-- ---------------------------------------------------------------- 1. dedupe
-- The unique index below cannot be created while any tenant holds two active
-- keys. No environment is known to, but a failed CREATE INDEX would abort the
-- boot migration and take the gateway down, so demote defensively first. Keeps
-- the OLDEST active key — it is the one existing envelopes were written under,
-- and shredding the wrong one makes stored blobs unreadable.
UPDATE vault.key k
   SET state = 'rotated', rotated_at = now()
 WHERE k.tier = 'tenant'
   AND k.state = 'active'
   AND EXISTS (
     SELECT 1 FROM vault.key older
      WHERE older.tier = 'tenant'
        AND older.state = 'active'
        AND older.scope_id = k.scope_id
        AND (older.issued_at, older.key_id) < (k.issued_at, k.key_id)
   );

-- ----------------------------------------------------------- 2. the invariant
-- "One active tenant key per tenant" becomes a database property rather than a
-- convention. Two concurrent first-uploads for a new tenant would otherwise race
-- and mint two keys; with this, the loser's insert conflicts and it re-reads the
-- winner's row. That is what makes ensureTenantKey safe without a lock.
CREATE UNIQUE INDEX IF NOT EXISTS key_one_active_tenant_key
  ON vault.key (scope_id)
  WHERE tier = 'tenant' AND state = 'active';

-- ------------------------------------------------------- 3. the platform root
-- A tenant key cannot be parentless: key_nonroot_parent requires a parent and
-- key_check_parent_tier requires it to be a strictly higher tier. Root is the
-- valid direct parent. Deliberately ONE canonical row identified by its kms_ref
-- rather than reusing whichever root happens to sort first — a stable, findable
-- parent is what makes this migration and ensureTenantKey agree on the hierarchy.
--
-- Under BYOK (Variant A) the customer's CMK is later interposed and the tenant
-- key is re-wrapped without re-encrypting leaf data, so parenting to the platform
-- root now is not a commitment that has to be undone.
INSERT INTO vault.key (tier, kms_ref, region, state, algorithm)
SELECT 'root', 'platform-root-v1', 'us-east-1', 'active', 'AES-256-GCM'
WHERE NOT EXISTS (
  SELECT 1 FROM vault.key WHERE tier = 'root' AND kms_ref = 'platform-root-v1'
);

-- ------------------------------------------------------------- 4. backfill
-- One key for every tenant that lacks one. Region follows the tenant's own
-- region so the key does not silently sit in a different jurisdiction from the
-- data it wraps. ON CONFLICT DO NOTHING makes a re-run harmless.
INSERT INTO vault.key (tier, scope_id, parent_key_id, kms_ref, region, state, algorithm, tenant_id)
SELECT 'tenant',
       t.tenant_id::text,
       (SELECT key_id FROM vault.key
         WHERE tier = 'root' AND kms_ref = 'platform-root-v1'
         ORDER BY issued_at LIMIT 1),
       'platform-tenant-' || t.tenant_id::text,
       t.region,
       'active',
       'AES-256-GCM',
       t.tenant_id
  FROM tenant.tenant t
 WHERE NOT EXISTS (
   SELECT 1 FROM vault.key k
    WHERE k.tier = 'tenant' AND k.scope_id = t.tenant_id::text AND k.state = 'active'
 )
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------- 5. audit
-- vault.key_operation is the local source of truth for key lifecycle, and a key
-- appearing with no issue row is exactly the gap that makes a vault unauditable.
-- Backfilled keys get theirs, attributed to the migration rather than to a user.
INSERT INTO vault.key_operation (key_id, op, operator_kind, operator_id, reason)
SELECT k.key_id, 'issue', 'service', 'migration:004_tenant_key_provisioning',
       'backfill: tenant creation never provisioned a tenant-tier key'
  FROM vault.key k
 WHERE k.tier = 'tenant'
   AND k.kms_ref LIKE 'platform-tenant-%'
   AND NOT EXISTS (
     SELECT 1 FROM vault.key_operation o WHERE o.key_id = k.key_id AND o.op = 'issue'
   );
