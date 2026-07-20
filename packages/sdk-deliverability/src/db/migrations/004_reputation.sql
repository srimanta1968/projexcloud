-- Migration 004: sdk-deliverability — bounce-rate auto-pause + reputation signals.
-- P14 · E3 (TK-3627). Auto-applied at boot. Additive + idempotent.
--
-- One reputation row per (tenant, channel) holding running send/delivery/bounce/complaint
-- counters + derived rates + a sending status. When the bounce or complaint rate crosses
-- a threshold the channel auto-pauses so the send path can hard-stop (protecting the
-- account's sender reputation) until a human resumes it.

CREATE TABLE IF NOT EXISTS deliverability.reputation (
  reputation_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms')),
  sent_count       BIGINT NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  delivered_count  BIGINT NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
  bounce_count     BIGINT NOT NULL DEFAULT 0 CHECK (bounce_count >= 0),
  complaint_count  BIGINT NOT NULL DEFAULT 0 CHECK (complaint_count >= 0),
  bounce_rate      NUMERIC(6,5) NOT NULL DEFAULT 0,
  complaint_rate   NUMERIC(6,5) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'good'
                     CHECK (status IN ('good','watch','paused')),
  paused_at        TIMESTAMPTZ,
  pause_reason     TEXT,
  resumed_at       TIMESTAMPTZ,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel)
);

CREATE INDEX IF NOT EXISTS deliverability_reputation_status_idx
  ON deliverability.reputation (status) WHERE status = 'paused';

COMMENT ON TABLE deliverability.reputation IS 'Per-(tenant,channel) send reputation counters + auto-pause status. Bounce/complaint rate over threshold => status=paused.';
