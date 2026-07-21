-- Down for 005_call_activity_idempotency.sql (P15 · E5, TK-3656).
-- Restores the non-unique lookup index that 003 created.

DROP INDEX IF EXISTS crm.crm_activity_external_call_uidx;

CREATE INDEX IF NOT EXISTS crm_activity_external_call_idx
  ON crm.activity (external_call_id) WHERE external_call_id IS NOT NULL;
