-- Migration 001: HDK foundation server anchors per P3-Canonical-Privacy-HDK-DataModel §12.
-- Auto-applied by @projexlight/migration-runner.
-- Schemas: hdk_idp, hdk_permissions.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS hdk_idp;
CREATE SCHEMA IF NOT EXISTS hdk_permissions;

-- hdk_idp.device_claim — biometric + PIN registered claim per device.
-- Sensitive material (biometric_template_envelope, pin_envelope) stored as
-- encrypted envelopes — actual encryption is performed by sdk-vault.
CREATE TABLE IF NOT EXISTS hdk_idp.device_claim (
  claim_id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid                  TEXT NOT NULL,
  person_id                    UUID NOT NULL,
  biometric_template_envelope  BYTEA,
  pin_envelope                 BYTEA,
  last_used_at                 TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (device_uuid, person_id)
);

CREATE INDEX IF NOT EXISTS device_claim_device_idx ON hdk_idp.device_claim (device_uuid);
CREATE INDEX IF NOT EXISTS device_claim_person_idx ON hdk_idp.device_claim (person_id);

-- hdk_idp.offline_auth_log — offline-auth events logged here on next sync.
CREATE TABLE IF NOT EXISTS hdk_idp.offline_auth_log (
  log_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid   TEXT NOT NULL,
  person_id     UUID NOT NULL,
  method        TEXT NOT NULL
                  CHECK (method IN ('biometric','pin','passkey')),
  occurred_at   TIMESTAMPTZ NOT NULL,
  synced_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS offline_auth_device_idx ON hdk_idp.offline_auth_log (device_uuid, occurred_at DESC);

-- hdk_permissions.surface_snapshot — per-device permission UI state.
CREATE TABLE IF NOT EXISTS hdk_permissions.surface_snapshot (
  snapshot_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid     TEXT NOT NULL,
  tenant_id       UUID NOT NULL,
  persona_id      UUID,
  permission_set  JSONB NOT NULL DEFAULT '{}'::jsonb,
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS surface_snapshot_device_idx ON hdk_permissions.surface_snapshot (device_uuid, taken_at DESC);
CREATE INDEX IF NOT EXISTS surface_snapshot_tenant_idx ON hdk_permissions.surface_snapshot (tenant_id, taken_at DESC);

COMMENT ON TABLE hdk_idp.device_claim       IS 'Biometric/PIN claim per (device, person). Material vaulted as envelopes.';
COMMENT ON TABLE hdk_idp.offline_auth_log   IS 'Audit log of offline auths (synced on next reconnect).';
COMMENT ON TABLE hdk_permissions.surface_snapshot IS 'Captured permission UI state per device.';
