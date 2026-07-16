-- Rollback for 003_crm_call_activity.sql (P15·E5).
--
-- NOT auto-applied (runner is forward-only). Idempotent. Drops the added call
-- fields and restores the original 001 kind CHECK (without 'voicemail').

DROP INDEX IF EXISTS crm.crm_activity_external_call_idx;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS external_call_id;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS voicemail_transcript;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS recording_consent;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS recording_url;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS phone_number;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS call_duration_seconds;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS call_disposition;
ALTER TABLE crm.activity DROP COLUMN IF EXISTS call_direction;

-- Restore the original kind CHECK (safe only if no 'voicemail' rows remain).
ALTER TABLE crm.activity DROP CONSTRAINT IF EXISTS activity_kind_check;
ALTER TABLE crm.activity ADD  CONSTRAINT activity_kind_check
  CHECK (kind IN ('call','email','meeting','note','task'));
