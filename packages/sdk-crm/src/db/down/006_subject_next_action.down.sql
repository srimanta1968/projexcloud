-- Rollback for 006_subject_next_action.sql (sdk-crm). NOT auto-applied — forward-only.
-- deal_id is NOT restored to NOT NULL: rows created for a lead, contact or ticket have
-- no deal, so re-imposing it would fail or force deleting real data.
DROP INDEX IF EXISTS crm.next_action_one_open_per_subject_idx;
DROP INDEX IF EXISTS crm.next_action_overdue_idx;
DROP INDEX IF EXISTS crm.next_action_subject_idx;
ALTER TABLE crm.next_action DROP CONSTRAINT IF EXISTS next_action_has_a_subject;
ALTER TABLE crm.next_action DROP COLUMN IF EXISTS intended_outcome;
ALTER TABLE crm.next_action DROP COLUMN IF EXISTS subject_kind;
ALTER TABLE crm.next_action DROP COLUMN IF EXISTS subject_ref;
