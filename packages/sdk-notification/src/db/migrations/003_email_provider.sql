-- Migration 003: sdk-notification · configurable email provider (platform default + tenant BYO).
-- Auto-applied by @projexlight/migration-runner on api-gateway startup. Idempotent.
--
-- Adds:
--   notification.provider                    — platform-default provider per channel
--                                              (mirror of ai_gateway.provider).
--   notification.tenant_provider_credential  — per-tenant BYO provider config + wrapped
--                                              credential (mirror of ai_gateway.tenant_provider_credential).
-- Resolution at send time is tenant-first, platform-fallback (see notificationService).
-- Credentials are stored ENVELOPE-ENCRYPTED via @projexlight/sdk-secrets; the raw
-- SMTP password / API key never lands in Postgres. `config` holds only non-secret
-- transport settings (host/port/secure/from).
--
-- Additive-only: also widens the notification.message.provider CHECK to allow the new
-- 'smtp' and 'sendgrid' kinds (existing rows remain valid).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS notification;

-- ─────────────────────────────────────────────────────────────────────
-- Platform-default provider (one active per channel). Operators configure
-- this via /admin/notifications/providers; used when a tenant has no BYO row.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification.provider (
  provider_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel             TEXT NOT NULL
                        CHECK (channel IN ('email','sms','whatsapp','push','slack')),
  kind                TEXT NOT NULL
                        CHECK (kind IN ('smtp','sendgrid','ses')),
  display_name        TEXT,
  -- Non-secret transport settings: {host, port, secure} for smtp; {region} for ses; {} for sendgrid.
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_address        TEXT,
  -- Wrapped secret (smtp password / api key) via sdk-secrets envelopeEncrypt. NULL when the
  -- provider needs no stored secret (e.g. SES via instance role).
  credential_envelope BYTEA,
  last_4              TEXT,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','revoked')),
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active platform-default provider per channel.
CREATE UNIQUE INDEX IF NOT EXISTS provider_active_channel_uniq
  ON notification.provider (channel) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────
-- Per-tenant BYO provider config. Overrides the platform default for the
-- owning tenant. RLS isolates rows by the per-request app.tenant_id GUC
-- (same convention as notification.message / notification.template).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification.tenant_provider_credential (
  binding_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  channel             TEXT NOT NULL
                        CHECK (channel IN ('email','sms','whatsapp','push','slack')),
  kind                TEXT NOT NULL
                        CHECK (kind IN ('smtp','sendgrid','ses')),
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  from_address        TEXT,
  credential_envelope BYTEA NOT NULL,
  last_4              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','revoked')),
  fallback_on_error   BOOLEAN NOT NULL DEFAULT TRUE,
  bound_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at          TIMESTAMPTZ,
  bound_by            TEXT,
  revoked_by          TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active config per (tenant, channel); revoked rows retained for audit.
CREATE UNIQUE INDEX IF NOT EXISTS tenant_provider_credential_active_uniq
  ON notification.tenant_provider_credential (tenant_id, channel)
  WHERE status = 'active';

-- Hot path: send-time resolver looks up the active config by (tenant, channel).
CREATE INDEX IF NOT EXISTS tenant_provider_credential_resolver_idx
  ON notification.tenant_provider_credential (tenant_id, channel, status);

-- List/audit views scan by tenant.
CREATE INDEX IF NOT EXISTS tenant_provider_credential_tenant_idx
  ON notification.tenant_provider_credential (tenant_id, bound_at DESC);

-- Row-level security: each tenant sees only its own rows. Operator queries via
-- the admin pool run as the table owner and bypass RLS. GUC app.tenant_id is set
-- per-request by dataService.withTenant(...), matching notification.message.
ALTER TABLE notification.tenant_provider_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.tenant_provider_credential FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.tenant_provider_credential;
CREATE POLICY tenant_isolation ON notification.tenant_provider_credential
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- ─────────────────────────────────────────────────────────────────────
-- Widen notification.message.provider to allow the new email kinds. Additive:
-- existing rows stay valid; only the set of accepted values grows.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE notification.message DROP CONSTRAINT IF EXISTS message_provider_check;
ALTER TABLE notification.message ADD CONSTRAINT message_provider_check
  CHECK (provider IN ('twilio','ses','whatsapp-bsp','apns','fcm','slack-outbound','smtp','sendgrid'));

COMMENT ON TABLE notification.provider
  IS 'Platform-default email/notification provider per channel. One active row per channel; used when a tenant has no BYO provider. credential_envelope is sdk-secrets-wrapped.';
COMMENT ON TABLE notification.tenant_provider_credential
  IS 'Per-tenant BYO notification provider (SMTP/SendGrid/SES). Overrides notification.provider for the owning tenant. RLS-isolated by app.tenant_id. credential_envelope is sdk-secrets-wrapped; last_4 for display only.';
COMMENT ON COLUMN notification.tenant_provider_credential.credential_envelope
  IS 'Envelope-encrypted SMTP password / API key via @projexlight/sdk-secrets; never holds raw material.';
COMMENT ON COLUMN notification.tenant_provider_credential.config
  IS 'Non-secret transport settings: {host, port, secure} for smtp; {region} for ses; {} for sendgrid.';
