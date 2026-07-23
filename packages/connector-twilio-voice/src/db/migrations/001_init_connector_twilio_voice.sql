-- Migration 001: connector-twilio-voice — tracking numbers + call mirror. P15 · E4 (TK-3652).
-- Auto-applied via api-gateway runMigrations.
--
-- Follows the connector mirror pattern (connector_<kind> schema, install-scoped
-- rows, UNIQUE(install_id, external_id)); the common install / cursor /
-- tool_manifest tables live in the shared `connectors` schema.
--
-- tracking_number: numbers provisioned from Twilio and pinned to a tenant so
-- inbound calls can be attributed to the campaign/source that owns the number.
-- voice_call: the mirror of one Twilio call leg, including recording and AMD
-- (answering-machine detection) outcome. The status/recording webhooks (TK-3653)
-- update these rows; sdk-voice consumes them.
--
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS connector_twilio_voice;

CREATE TABLE IF NOT EXISTS connector_twilio_voice.tracking_number (
  tracking_number_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  -- Twilio's IncomingPhoneNumber SID — the upstream id for this mirror row.
  external_id        TEXT NOT NULL,
  phone_number       TEXT NOT NULL,
  friendly_name      TEXT,
  capabilities       JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What this number is tracking (campaign / source / persona), free-form ref.
  purpose            TEXT,
  assigned_persona_id UUID,
  status             TEXT NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','released','deleted-upstream')),
  provisioned_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at        TIMESTAMPTZ,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (install_id, external_id)
);
-- One ACTIVE claim per E.164 number per tenant; released rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS twilio_voice_number_active_idx
  ON connector_twilio_voice.tracking_number (tenant_id, phone_number)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS twilio_voice_number_install_idx
  ON connector_twilio_voice.tracking_number (install_id, last_sync_at DESC);

CREATE TABLE IF NOT EXISTS connector_twilio_voice.voice_call (
  voice_call_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id         UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  -- Twilio Call SID. UNIQUE per install so status callbacks are idempotent.
  external_id        TEXT NOT NULL,
  direction          TEXT NOT NULL DEFAULT 'outbound'
                       CHECK (direction IN ('inbound','outbound')),
  from_number        TEXT NOT NULL,
  to_number          TEXT NOT NULL,
  tracking_number_id UUID REFERENCES connector_twilio_voice.tracking_number (tracking_number_id) ON DELETE SET NULL,
  subject_persona_id UUID,
  initiated_by_persona_id UUID,
  -- Twilio call status vocabulary, plus 'canceled' spelling as Twilio sends it.
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','initiated','ringing','in-progress','completed','busy','no-answer','canceled','failed')),
  -- Answering-machine detection outcome (Twilio AnsweredBy). 'machine_start'
  -- and friends are what turn a call into a voicemail (TK-3653).
  answered_by        TEXT
                       CHECK (answered_by IN ('human','machine_start','machine_end_beep','machine_end_silence','machine_end_other','fax','unknown')),
  duration_seconds   INTEGER CHECK (duration_seconds >= 0),
  recording_url      TEXT,
  recording_sid      TEXT,
  recording_duration_seconds INTEGER CHECK (recording_duration_seconds >= 0),
  -- Set when the call is classified as reaching voicemail rather than a human.
  is_voicemail       BOOLEAN NOT NULL DEFAULT false,
  voicemail_transcript TEXT,
  error_code         TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at        TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ,
  last_sync_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (install_id, external_id)
);
CREATE INDEX IF NOT EXISTS twilio_voice_call_tenant_idx
  ON connector_twilio_voice.voice_call (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS twilio_voice_call_install_idx
  ON connector_twilio_voice.voice_call (install_id, last_sync_at DESC);

COMMENT ON SCHEMA connector_twilio_voice IS 'connector-twilio-voice mirror tables (P15·E4). Common install/cursor/tool_manifest live in the connectors schema.';
COMMENT ON TABLE  connector_twilio_voice.tracking_number IS 'Twilio numbers provisioned per tenant for call attribution. One active claim per (tenant, phone_number).';
COMMENT ON TABLE  connector_twilio_voice.voice_call IS 'Mirror of one Twilio call leg incl. recording + AMD outcome. UNIQUE(install_id, external_id) makes status callbacks idempotent.';
COMMENT ON COLUMN connector_twilio_voice.voice_call.answered_by IS 'Twilio AnsweredBy (AMD): machine_* values classify the call as voicemail.';
