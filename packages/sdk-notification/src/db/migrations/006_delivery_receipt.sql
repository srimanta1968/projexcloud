-- Migration 006: sdk-notification — delivery-status callback receipts.
-- P14 · E4 (TK-3636). Auto-applied at boot. Additive + idempotent.
--
-- Records each provider delivery-status callback (Twilio/SES/SendGrid) and maps it onto
-- the existing notification.message state machine (sent -> delivered via markDelivered).
-- Idempotent per (provider, provider_message_id, status) so re-delivered callbacks and
-- the sent->delivered transition fire at most once.

CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE IF NOT EXISTS notification.delivery_receipt (
  receipt_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  provider            TEXT NOT NULL,
  provider_message_id TEXT NOT NULL,
  message_id          UUID,
  status              TEXT NOT NULL
                        CHECK (status IN ('queued','sent','delivered','failed','bounced','undelivered','complaint')),
  error_code          TEXT,
  matched             BOOLEAN NOT NULL DEFAULT false,
  signature_verified  BOOLEAN NOT NULL DEFAULT false,
  raw                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id, status)
);

CREATE INDEX IF NOT EXISTS notification_delivery_receipt_tenant_idx
  ON notification.delivery_receipt (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS notification_delivery_receipt_msg_idx
  ON notification.delivery_receipt (provider, provider_message_id);

COMMENT ON TABLE notification.delivery_receipt IS 'Provider delivery-status callbacks (Twilio/SES/SendGrid), idempotent per (provider, provider_message_id, status). Maps onto notification.message via markDelivered.';
