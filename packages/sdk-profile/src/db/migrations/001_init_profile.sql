-- Migration 001: sdk-profile canonical schema per P3-Canonical-Privacy-HDK-DataModel §4.1.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
-- Tables: profile.{band_l2, secure_data, field_shred_log}.
-- FR-PRF-1..6.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS profile;

-- profile.band_l2 — Profile / Preference / Notification-routing per App Identity (L2).
-- Per-field envelopes encrypted under Person Key with per-app salt (sdk-vault).
CREATE TABLE IF NOT EXISTS profile.band_l2 (
  band_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_identity_id   UUID NOT NULL,
  band_kind         TEXT NOT NULL
                      CHECK (band_kind IN ('profile','preference','notification_routing')),
  tenant_id         UUID NOT NULL,
  fields_envelope   JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_identity_id, band_kind)
);

CREATE INDEX IF NOT EXISTS band_l2_app_idx     ON profile.band_l2 (app_identity_id);
CREATE INDEX IF NOT EXISTS band_l2_tenant_idx  ON profile.band_l2 (tenant_id, band_kind);

-- profile.secure_data — Master Person regulated data (per-field envelopes).
-- Each field independently shreddable (FR-PRF-6).
CREATE TABLE IF NOT EXISTS profile.secure_data (
  person_id         UUID PRIMARY KEY,
  field_envelopes   JSONB NOT NULL DEFAULT '{}'::jsonb,
  field_states      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- profile.field_shred_log — every per-field shred (regulated audit).
CREATE TABLE IF NOT EXISTS profile.field_shred_log (
  shred_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id         UUID NOT NULL,
  field_name        TEXT NOT NULL,
  reason            TEXT NOT NULL
                      CHECK (reason IN ('retention-expiry','dsar-erasure','operator-request')),
  audit_entry_id    UUID,
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS field_shred_person_idx ON profile.field_shred_log (person_id, occurred_at DESC);

COMMENT ON TABLE profile.band_l2 IS 'Profile/Preference/Notification-routing bands on L2 App Identity (per-app). FR-PRF-1.';
COMMENT ON TABLE profile.secure_data IS 'Master Person Secure Data band: DL · PAN · Aadhaar · SSN · Passport · PCI per-field envelopes. FR-PRF-2.';
COMMENT ON TABLE profile.field_shred_log IS 'Append-only log of every per-field shred. FR-PRF-6.';
