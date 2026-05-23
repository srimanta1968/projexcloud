-- Migration 001: sdk-device canonical schema per P3-Canonical-Privacy-HDK-DataModel §9.1.
-- Auto-applied by @projexlight/migration-runner.
-- Tables: device.{device, attestation, person_link}.
-- FR-DEV-1..5.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS device;

CREATE TABLE IF NOT EXISTS device.device (
  device_uuid     TEXT PRIMARY KEY,
  device_key_ref  UUID,
  platform        TEXT NOT NULL
                    CHECK (platform IN ('ios','android','web','desktop')),
  os_version      TEXT,
  app_version     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','revoked','stolen')),
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS device_platform_idx ON device.device (platform, status);

CREATE TABLE IF NOT EXISTS device.attestation (
  attestation_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid         TEXT NOT NULL REFERENCES device.device(device_uuid) ON DELETE CASCADE,
  method              TEXT NOT NULL
                        CHECK (method IN ('secure-enclave','key-attestation','safetynet','play-integrity')),
  signature_envelope  BYTEA NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  verified            BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS attestation_device_idx ON device.attestation (device_uuid, occurred_at DESC);

CREATE TABLE IF NOT EXISTS device.person_link (
  link_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_uuid    TEXT NOT NULL REFERENCES device.device(device_uuid) ON DELETE CASCADE,
  person_id      UUID NOT NULL,
  first_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','suspended','revoked')),
  UNIQUE (device_uuid, person_id)
);

CREATE INDEX IF NOT EXISTS device_link_person_idx ON device.person_link (person_id);

COMMENT ON TABLE device.device IS 'Canonical device_uuid registry. Coexistence pattern with HDK.';
COMMENT ON TABLE device.attestation IS 'Signed device claim history (FR-DEV-2).';
COMMENT ON TABLE device.person_link IS 'Many-to-many person ↔ device.';
