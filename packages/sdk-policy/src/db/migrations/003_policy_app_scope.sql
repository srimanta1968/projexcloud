-- Migration 003: let an ABAC policy belong to ONE app, not just to a tenant.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- THE GAP
-- -------
-- policy.policy was keyed (tenant_id, name, version) with no app column, so every
-- app belonging to a tenant was governed by the same rule set. That is the one
-- place the platform's "set it once for all my apps, override it for one app"
-- model did not hold: config.config_value has scope IN (platform,tenant,app,
-- app_user) and tenant.role_template is keyed (tenant_id, app_id, name), but
-- policy had no equivalent — a tenant running a customer-facing app and an
-- internal ops app could not give them different access rules.
--
-- THE SHAPE MIRRORS role_template, DELIBERATELY
-- ---------------------------------------------
--   tenant_id NULL, app_id NULL  -> platform default, applies everywhere
--   tenant_id SET,  app_id NULL  -> tenant-wide: all of that tenant's apps
--   tenant_id SET,  app_id SET   -> that one app only
--
-- Nullable rather than NOT NULL because the existing rows are all tenant-wide
-- and they must stay that way: stamping them with an app would silently narrow
-- live access rules, which is the one migration outcome nobody could safely
-- review after the fact. An absent app_id keeps meaning "all apps".
ALTER TABLE policy.policy ADD COLUMN IF NOT EXISTS app_id TEXT;

-- The old constraint cannot express the split: it would let one tenant-wide and
-- one per-app policy collide on (tenant_id, name, version), or forbid a
-- legitimate per-app override of a tenant-wide rule of the same name.
--
-- Two PARTIAL indexes rather than one four-column UNIQUE, because Postgres
-- treats NULLs as distinct in a unique index — a plain UNIQUE (tenant_id,
-- app_id, name, version) would permit unlimited duplicate tenant-wide rows,
-- which is exactly the uniqueness the old constraint was providing.
ALTER TABLE policy.policy DROP CONSTRAINT IF EXISTS policy_tenant_id_name_version_key;

CREATE UNIQUE INDEX IF NOT EXISTS policy_tenant_wide_uniq
  ON policy.policy (tenant_id, name, version) WHERE app_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS policy_app_scoped_uniq
  ON policy.policy (tenant_id, app_id, name, version) WHERE app_id IS NOT NULL;

-- Serves listPoliciesForScope: active rules for one app plus the tenant-wide
-- ones it inherits.
CREATE INDEX IF NOT EXISTS policy_app_active_idx
  ON policy.policy (tenant_id, app_id, status) WHERE status = 'active';

COMMENT ON COLUMN policy.policy.app_id IS
  'Owning app. NULL = applies to every app of this tenant (or platform-wide when tenant_id is also NULL). Mirrors tenant.role_template scoping.';
