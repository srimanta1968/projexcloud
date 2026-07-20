-- Migration 005: sdk-notification — inbound SMS + STOP/HELP/START keyword handling.
-- P14 · E4 (TK-3634). Auto-applied at boot. Additive + idempotent.
--
-- Records each inbound SMS (Twilio) and its recognized keyword intent (opt_out / opt_in /
-- help / none). Idempotent per (provider, message_sid) so re-delivered webhooks don't
-- double-process. Per-tenant sms_settings holds the HMAC signing secret + the configured
-- HELP/opt-out/opt-in auto-reply text.

CREATE SCHEMA IF NOT EXISTS notification;

CREATE TABLE IF NOT EXISTS notification.sms_inbound (
  inbound_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  provider       TEXT NOT NULL DEFAULT 'twilio',
  from_number    TEXT NOT NULL,
  to_number      TEXT,
  body           TEXT,
  message_sid    TEXT,
  keyword_intent TEXT NOT NULL DEFAULT 'none'
                   CHECK (keyword_intent IN ('opt_out','opt_in','help','none')),
  action_taken   TEXT,
  reply_sent     TEXT,
  signature_verified BOOLEAN NOT NULL DEFAULT false,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency: a provider re-delivery of the same message is a no-op.
  UNIQUE (provider, message_sid)
);

CREATE INDEX IF NOT EXISTS notification_sms_inbound_tenant_idx
  ON notification.sms_inbound (tenant_id, received_at);
CREATE INDEX IF NOT EXISTS notification_sms_inbound_from_idx
  ON notification.sms_inbound (tenant_id, from_number, keyword_intent);

CREATE TABLE IF NOT EXISTS notification.sms_settings (
  tenant_id      UUID PRIMARY KEY,
  signing_secret TEXT,
  help_reply     TEXT NOT NULL DEFAULT 'Reply STOP to unsubscribe, START to resubscribe. Msg&data rates may apply.',
  opt_out_reply  TEXT NOT NULL DEFAULT 'You have been unsubscribed and will receive no more messages. Reply START to resubscribe.',
  opt_in_reply   TEXT NOT NULL DEFAULT 'You have been resubscribed. Reply STOP to unsubscribe.',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification.sms_inbound IS 'Inbound SMS with recognized keyword intent (STOP/HELP/START). Idempotent per (provider, message_sid).';
COMMENT ON TABLE notification.sms_settings IS 'Per-tenant inbound-SMS config: HMAC signing secret + HELP/opt-out/opt-in auto-reply text.';
