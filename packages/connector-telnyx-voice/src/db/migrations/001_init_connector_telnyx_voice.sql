-- Migration 001: connector-telnyx-voice — Telnyx call mirror. VA·E6 (TK-4501, TK-4502).
-- Auto-applied via api-gateway runMigrations.
--
-- Mirror pattern (as connector-twilio-voice): one row per Telnyx call leg, updated from
-- signed status webhooks. Telnyx retries and may reorder webhooks, so
--   * webhook_event records every processed event id — a redelivered event is a no-op;
--   * a status never moves backwards (the service keeps the furthest-progressed one).
-- tenant_id is resolved from the Telnyx connection (the tenant's SIP trunk); ai_call_id is a
-- loose ref to voice_agent.call when the leg belongs to an AI call.
--
-- Idempotent; down in ../down/.

CREATE SCHEMA IF NOT EXISTS connector_telnyx_voice;

CREATE TABLE IF NOT EXISTS connector_telnyx_voice.voice_call (
  voice_call_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID,
  -- Telnyx call_leg_id: the stable id for this leg (UNIQUE -> idempotent upsert).
  external_id      TEXT NOT NULL UNIQUE,
  call_control_id  TEXT,
  call_session_id  TEXT,
  connection_id    TEXT,
  direction        TEXT CHECK (direction IN ('inbound','outbound')),
  from_number      TEXT,
  to_number        TEXT,
  status           TEXT NOT NULL DEFAULT 'initiated'
                     CHECK (status IN ('initiated','ringing','in-progress','completed','busy','no-answer','canceled','failed')),
  hangup_cause     TEXT,
  answered_by      TEXT CHECK (answered_by IN ('human','machine','unknown')),
  ai_call_id       UUID,
  last_event_type  TEXT,
  last_event_at    TIMESTAMPTZ,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telnyx_voice_call_tenant_idx ON connector_telnyx_voice.voice_call (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS telnyx_voice_call_ai_idx ON connector_telnyx_voice.voice_call (ai_call_id) WHERE ai_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS connector_telnyx_voice.webhook_event (
  event_id     TEXT PRIMARY KEY,
  event_type   TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE connector_telnyx_voice.voice_call IS 'Mirror of one Telnyx call leg, updated from signed webhooks; UNIQUE(external_id) + webhook_event make ingestion idempotent.';
