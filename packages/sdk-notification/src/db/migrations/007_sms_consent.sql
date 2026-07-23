-- Migration 007: sdk-notification — SMS consent state (opt-out propagation).
-- P14 · E4 (TK-3635). Auto-applied at boot. Additive + idempotent.
--
-- Per-(tenant, number) SMS consent state driven by STOP/START. PII-safe: the number is
-- stored ONLY as a sha256 hash + the last 4 digits + its E.164 shape — never plaintext.
-- Idempotent per (tenant_id, phone_hash) so duplicate inbound STOP/START are no-ops.

CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE IF NOT EXISTS notification.sms_consent (
  consent_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  phone_hash     TEXT NOT NULL,
  phone_last4    TEXT,
  is_e164        BOOLEAN NOT NULL DEFAULT true,
  channel        TEXT NOT NULL DEFAULT 'sms',
  status         TEXT NOT NULL DEFAULT 'opted_in'
                   CHECK (status IN ('opted_in','opted_out')),
  purpose        TEXT NOT NULL DEFAULT 'marketing',
  reason         TEXT,
  source         TEXT,
  opted_out_at   TIMESTAMPTZ,
  opted_in_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_hash)
);

CREATE INDEX IF NOT EXISTS notification_sms_consent_tenant_idx
  ON notification.sms_consent (tenant_id, status);

COMMENT ON TABLE notification.sms_consent IS 'SMS consent state per (tenant, hashed number). STOP -> opted_out (+suppression+consent revoke), START -> opted_in. PII-safe: hash + last4 only.';
