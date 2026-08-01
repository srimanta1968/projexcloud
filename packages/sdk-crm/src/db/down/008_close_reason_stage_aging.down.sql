-- Rollback for 008_close_reason_stage_aging.sql (sdk-crm). NOT auto-applied.
DROP TABLE IF EXISTS crm.stage_entry;
DROP TABLE IF EXISTS crm.subject_close;
DROP TABLE IF EXISTS crm.close_reason_type;
