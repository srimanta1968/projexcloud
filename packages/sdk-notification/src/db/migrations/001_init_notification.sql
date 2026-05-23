-- Migration 001: sdk-notification canonical schema per P4-Operational-Billing-DataModel §5.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
--
-- Tables: notification.{template, message, quiet_hours}
-- Pool placement: Admin Pool per PRD §5.2.
-- FR-NTF-1..6 per PRD §5.2.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS notification;

-- notification.template per §5.1
-- tenant_id NULL = platform-default; tenant override gets its own row.
-- required_consent_purpose links to consent.purpose for FR-NTF-4 pre-flight.
CREATE TABLE IF NOT EXISTS notification.template (
  template_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID,
  code                     TEXT NOT NULL,
  channel                  TEXT NOT NULL
                             CHECK (channel IN ('email','sms','whatsapp','push','slack')),
  locale_bundles           JSONB NOT NULL DEFAULT '{}'::jsonb,
  required_consent_purpose TEXT,
  version                  TEXT NOT NULL DEFAULT '1.0.0',
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('draft','active','deprecated','retired')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform-default templates unique by (code, channel, version)
CREATE UNIQUE INDEX IF NOT EXISTS template_global_uniq
  ON notification.template (code, channel, version) WHERE tenant_id IS NULL;
-- Tenant-override templates unique by (tenant_id, code, channel, version)
CREATE UNIQUE INDEX IF NOT EXISTS template_tenant_uniq
  ON notification.template (tenant_id, code, channel, version) WHERE tenant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS template_code_idx ON notification.template (code, channel, status);

-- notification.message per §5.1
-- destination_envelope is vault-wrapped recipient address (PII-grade).
-- consent_check_ref FK proves pre-flight consent check per FR-NTF-4.
CREATE TABLE IF NOT EXISTS notification.message (
  message_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  template_id          UUID NOT NULL REFERENCES notification.template(template_id) ON DELETE RESTRICT,
  person_id            UUID NOT NULL,
  app_identity_id      UUID,
  channel              TEXT NOT NULL
                         CHECK (channel IN ('email','sms','whatsapp','push','slack')),
  provider             TEXT NOT NULL
                         CHECK (provider IN ('twilio','ses','whatsapp-bsp','apns','fcm','slack-outbound')),
  destination_envelope BYTEA NOT NULL,
  payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sending','sent','delivered','failed','bounced','suppressed')),
  scheduled_at         TIMESTAMPTZ,
  sent_at              TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  consent_check_ref    UUID,
  provider_message_id  TEXT,
  suppression_reason   TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_tenant_idx    ON notification.message (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_person_idx    ON notification.message (person_id);
CREATE INDEX IF NOT EXISTS message_status_idx    ON notification.message (status);
CREATE INDEX IF NOT EXISTS message_queued_idx    ON notification.message (scheduled_at)
  WHERE status IN ('queued','sending');

-- notification.quiet_hours per §5.1 - per-persona DND windows.
-- windows is jsonb array of {dow:0-6, start:'HH:MM', end:'HH:MM', tz:'Area/City'}.
CREATE TABLE IF NOT EXISTS notification.quiet_hours (
  persona_id  UUID PRIMARY KEY,
  windows     JSONB NOT NULL DEFAULT '[]'::jsonb,
  dnd         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification.template    IS 'Per P4-DataModel §5.1. Platform default (tenant_id NULL) or tenant-override. required_consent_purpose links to consent.purpose.';
COMMENT ON TABLE notification.message     IS 'Per FR-NTF-1..4. destination_envelope vault-wrapped; consent_check_ref proves pre-flight gate.';
COMMENT ON TABLE notification.quiet_hours IS 'Per FR-NTF-5. windows jsonb [{dow, start, end, tz}].';
