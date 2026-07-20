-- Migration 002: sdk-deliverability — provider bounce/complaint webhooks.
-- P14 · E3 (TK-3625). Auto-applied at boot. Additive + idempotent.
--
-- Per-tenant/provider HMAC signing secret for inbound webhook verification, plus an
-- append-only bounce_event audit of every processed provider notification (SendGrid /
-- Mailgun / Postmark / SES / Twilio). Hard bounces + complaints auto-suppress the
-- recipient (via the suppression service) so they never receive another send.

CREATE TABLE IF NOT EXISTS deliverability.webhook_secret (
  secret_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  provider        TEXT NOT NULL
                    CHECK (provider IN ('ses','sendgrid','mailgun','postmark','twilio')),
  -- Raw HMAC signing key. In production this should be a vault ref (sdk-secrets);
  -- stored inline here for the SDK to stay self-contained.
  signing_secret  TEXT NOT NULL,
  algo            TEXT NOT NULL DEFAULT 'sha256' CHECK (algo IN ('sha1','sha256')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS deliverability_webhook_secret_idx
  ON deliverability.webhook_secret (tenant_id, provider) WHERE is_active;

-- Append-only audit of every processed provider notification.
CREATE TABLE IF NOT EXISTS deliverability.bounce_event (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  provider        TEXT NOT NULL,
  event_type      TEXT,
  classification  TEXT NOT NULL
                    CHECK (classification IN ('hard_bounce','soft_bounce','complaint','delivered','other')),
  channel         TEXT NOT NULL DEFAULT 'email',
  address_hash    TEXT,
  message_id      TEXT,
  suppressed      BOOLEAN NOT NULL DEFAULT false,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deliverability_bounce_event_tenant_idx
  ON deliverability.bounce_event (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS deliverability_bounce_event_class_idx
  ON deliverability.bounce_event (tenant_id, classification, received_at);

COMMENT ON TABLE deliverability.webhook_secret IS 'Per-tenant/provider HMAC signing key for inbound bounce/complaint webhook verification.';
COMMENT ON TABLE deliverability.bounce_event IS 'Append-only audit of processed provider bounce/complaint notifications. hard_bounce/complaint auto-suppress.';
