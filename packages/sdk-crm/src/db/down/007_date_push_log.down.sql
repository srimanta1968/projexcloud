-- Rollback for 007_date_push_log.sql (sdk-crm). NOT auto-applied — forward-only.
DROP TABLE IF EXISTS crm.overdue_policy;
DROP TABLE IF EXISTS crm.date_push_log;
DROP TRIGGER IF EXISTS next_action_freeze_original_due_trg ON crm.next_action;
DROP FUNCTION IF EXISTS crm.freeze_original_due();
DROP FUNCTION IF EXISTS crm.reject_push_log_edit();
ALTER TABLE crm.next_action DROP COLUMN IF EXISTS original_due_at;
ALTER TABLE crm.next_action DROP COLUMN IF EXISTS push_count;
