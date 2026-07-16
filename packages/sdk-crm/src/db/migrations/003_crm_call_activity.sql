-- Migration 003: sdk-crm — 'voicemail' activity kind + structured call fields.
-- P15 · E5. Auto-applied by the migration runner at boot.
--
-- ADDITIVE + idempotent. Widens crm.activity.kind to include 'voicemail' and
-- adds structured telephony fields so calls/voicemails logged from
-- connector-twilio-voice (P15·E4) carry direction, disposition, duration,
-- recording + consent, and transcript. Existing activity rows are preserved.

-- Widen the kind CHECK to add 'voicemail'. DROP+ADD (IF EXISTS) is re-runnable;
-- the new set is a superset so existing rows still satisfy it.
ALTER TABLE crm.activity DROP CONSTRAINT IF EXISTS activity_kind_check;
ALTER TABLE crm.activity ADD  CONSTRAINT activity_kind_check
  CHECK (kind IN ('call','email','meeting','note','task','voicemail'));

-- Structured call/voicemail fields.
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS call_direction TEXT
  CHECK (call_direction IN ('inbound','outbound'));
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS call_disposition TEXT
  CHECK (call_disposition IN ('answered','no_answer','busy','failed','voicemail','left_message'));
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS call_duration_seconds INTEGER
  CHECK (call_duration_seconds >= 0);
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS recording_consent BOOLEAN;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS voicemail_transcript TEXT;
ALTER TABLE crm.activity ADD COLUMN IF NOT EXISTS external_call_id TEXT;

CREATE INDEX IF NOT EXISTS crm_activity_external_call_idx
  ON crm.activity (external_call_id) WHERE external_call_id IS NOT NULL;

COMMENT ON COLUMN crm.activity.call_disposition IS 'Call outcome incl. voicemail/left_message (P15·E5 call-activity).';
COMMENT ON COLUMN crm.activity.recording_consent IS 'Whether recording consent was captured (sdk-consent) before recording.';
