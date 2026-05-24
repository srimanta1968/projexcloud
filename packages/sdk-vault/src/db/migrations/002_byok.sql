-- Migration 002: BYOK / CMEK extension to sdk-vault per
-- docs/v3.1/datamodel/P8-Deployment-Variants-DataModel.html §3.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).
--
-- Variant A · BYOK. Customer's CMK becomes the wrapping key for the
-- Tenant Key — sits between Pool KEK and Tenant Key. Revoke ⇒ tenant
-- data undecryptable across all pools.

-- ---------------------------------------------------------------------------
-- vault.byok_binding — one row per tenant that has opted into BYOK.
-- One-to-one with tenant (UNIQUE tenant_id) so a tenant has at most one
-- active CMK binding at a time. Switching providers means revoke + re-bind.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.byok_binding (
  binding_id                       TEXT PRIMARY KEY,
  tenant_id                        UUID NOT NULL UNIQUE,
  provider                         TEXT NOT NULL CHECK (
    provider IN ('aws-kms','gcp-kms','hsm-pkcs11')
  ),
  customer_kms_key_arn             TEXT NOT NULL,
  -- Logical FK to vault.key.key_id; left logical (TEXT) to avoid cross-tier
  -- hard FK and to keep the column type aligned with sdk-vault primary keys.
  tenant_key_id                    TEXT NOT NULL,
  grant_status                     TEXT NOT NULL DEFAULT 'active' CHECK (
    grant_status IN ('active','revoking','revoked','degraded')
  ),
  bound_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at                       TIMESTAMPTZ,
  sla_revoke_propagation_seconds   INTEGER NOT NULL DEFAULT 30 CHECK (
    sla_revoke_propagation_seconds > 0
  ),
  siem_forwarder_endpoint          TEXT
);

CREATE INDEX IF NOT EXISTS byok_binding_status_idx
  ON vault.byok_binding (grant_status);
CREATE INDEX IF NOT EXISTS byok_binding_provider_idx
  ON vault.byok_binding (provider);

-- ---------------------------------------------------------------------------
-- vault.cmk_use_log — every CMK call (audit + optional SIEM forward).
-- High-volume on the unwrap path (every Tenant Key access); we keep the
-- row narrow + skip-indexed for cheap inserts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.cmk_use_log (
  log_id                TEXT PRIMARY KEY,
  binding_id            TEXT NOT NULL REFERENCES vault.byok_binding(binding_id) ON DELETE CASCADE,
  operation             TEXT NOT NULL CHECK (
    operation IN ('wrap','unwrap','rotate','grant-check')
  ),
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms            INTEGER NOT NULL CHECK (latency_ms >= 0),
  provider_response     JSONB NOT NULL DEFAULT '{}'::jsonb,
  forwarded_to_siem_at  TIMESTAMPTZ,
  -- Logical FK to audit.entry. Chain anchor for the regulated event.
  audit_entry_id        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cmk_use_log_binding_idx
  ON vault.cmk_use_log (binding_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cmk_use_log_operation_idx
  ON vault.cmk_use_log (operation, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cmk_use_log_siem_pending_idx
  ON vault.cmk_use_log (binding_id, occurred_at)
  WHERE forwarded_to_siem_at IS NULL;

-- ---------------------------------------------------------------------------
-- vault.cmk_rotation — one row per Tenant-Key re-wrap event.
-- leaf_reencryption_needed should ALWAYS be false (FR-BYOK-5): the rotation
-- is transparent and only re-wraps the Tenant Key, not any leaf data.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vault.cmk_rotation (
  rotation_id                TEXT PRIMARY KEY,
  binding_id                 TEXT NOT NULL REFERENCES vault.byok_binding(binding_id) ON DELETE CASCADE,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at               TIMESTAMPTZ,
  previous_tenant_key_id     TEXT NOT NULL,
  new_tenant_key_id          TEXT NOT NULL,
  leaf_reencryption_needed   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS cmk_rotation_binding_idx
  ON vault.cmk_rotation (binding_id, started_at DESC);

COMMENT ON TABLE vault.byok_binding  IS 'P8 Variant A. Per-tenant CMK binding; revoke renders data undecryptable.';
COMMENT ON TABLE vault.cmk_use_log   IS 'P8 Variant A. Append-only CMK call log; mirrored to customer SIEM when configured.';
COMMENT ON TABLE vault.cmk_rotation  IS 'P8 Variant A. Transparent Tenant-Key re-wrap on customer-driven CMK rotation.';
