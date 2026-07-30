-- Migration 002: tenant applications, and the columns a per-application key needs.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- WHY AN APPLICATION AND NOT ONE KEY PER TENANT
-- ---------------------------------------------
-- A tenant runs more than one thing against the platform: a web backend, a
-- nightly job, a mobile BFF, a staging copy of each. One shared credential
-- means a leak forces every one of them to rotate at the same moment, no call
-- can be attributed to the caller that made it, and least privilege is
-- impossible because the key must hold the union of every app's scopes. The
-- industry settled this long ago (Stripe restricted keys, SendGrid named keys,
-- AWS IAM, Auth0 M2M clients): the credential belongs to an application.

CREATE TABLE IF NOT EXISTS api_keys.application (
  application_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL,
  description          TEXT,
  -- live/test is a property of the APPLICATION, not of an individual key, so a
  -- test app can never mint a credential that reaches production data by
  -- accident. The key prefix (pk_test_ / pk_live_) is derived from this.
  environment          TEXT NOT NULL DEFAULT 'live'
                         CHECK (environment IN ('live','test')),
  status               TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','disabled')),
  owner_persona_id     UUID,
  created_by_persona_id UUID,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at          TIMESTAMPTZ
);

-- Slug is the client_id a customer puts in their config, so it must be stable
-- and unique within the tenant. Not globally unique: two tenants may both have
-- an app called "web-backend" and neither should learn about the other.
CREATE UNIQUE INDEX IF NOT EXISTS application_tenant_slug_idx
  ON api_keys.application (tenant_id, slug);
CREATE INDEX IF NOT EXISTS application_tenant_status_idx
  ON api_keys.application (tenant_id, status);

-- application_id is DELIBERATELY NULLABLE.
-- sdk-command mints per-robot credentials into this same table through
-- issueRobotCredential; those are system credentials belonging to an asset, not
-- to a tenant application. A NOT NULL column would make every existing robot
-- credential unrepresentable and break POST /api/commands/:command_id/ack at
-- the next boot. RESTRICT rather than CASCADE so deleting an application can
-- never silently delete a credential that something is still using.
ALTER TABLE api_keys.key
  ADD COLUMN IF NOT EXISTS application_id UUID
    REFERENCES api_keys.application (application_id) ON DELETE RESTRICT;
ALTER TABLE api_keys.key ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE api_keys.key ADD COLUMN IF NOT EXISTS environment TEXT;
ALTER TABLE api_keys.key ADD COLUMN IF NOT EXISTS created_by_persona_id UUID;
ALTER TABLE api_keys.key ADD COLUMN IF NOT EXISTS last_used_ip INET;

-- key_lookup is HMAC-SHA256(pepper, plaintext): a constant-time-comparable,
-- INDEXABLE value that lets verification find the row in one indexed read.
-- The old key_hash column is a PBKDF2 digest at 310,000 iterations, which had
-- to be recomputed on every single request before a lookup was even possible —
-- ~100ms of synchronous CPU per authenticated call, on the gateway's event
-- loop. A key is 192 bits of generated entropy, not a human password, so the
-- slow KDF was buying nothing that a keyed hash does not already give.
--
-- Nullable during the transition: rows issued before this migration have no
-- lookup value and verify by the legacy path until first use upgrades them.
ALTER TABLE api_keys.key ADD COLUMN IF NOT EXISTS key_lookup BYTEA;
CREATE UNIQUE INDEX IF NOT EXISTS apikey_lookup_idx
  ON api_keys.key (key_lookup) WHERE key_lookup IS NOT NULL;

CREATE INDEX IF NOT EXISTS apikey_application_idx
  ON api_keys.key (application_id) WHERE application_id IS NOT NULL;

-- hash_alg records how key_hash was derived. 'hmac-sha256' rows keep key_hash
-- populated for defence in depth but are found through key_lookup.
ALTER TABLE api_keys.key DROP CONSTRAINT IF EXISTS key_hash_alg_check;
ALTER TABLE api_keys.key
  ADD CONSTRAINT key_hash_alg_check
  CHECK (hash_alg IN ('pbkdf2-sha256-310000','argon2id','hmac-sha256'));

COMMENT ON TABLE  api_keys.application IS
  'A tenant application (client). Credentials belong to one of these so a leak, a rotation and a usage figure are all scoped to a single integration.';
COMMENT ON COLUMN api_keys.key.application_id IS
  'NULL for system credentials such as sdk-command per-robot keys, which belong to an asset rather than to a tenant application.';
COMMENT ON COLUMN api_keys.key.key_lookup IS
  'HMAC-SHA256(API_KEY_PEPPER, plaintext). Indexed, so verification is one indexed read instead of a 310k-iteration PBKDF2 on the request path.';
