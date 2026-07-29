-- Rollback for 001_init_import.sql (sdk-import).
-- NOT auto-applied — the migration ledger is forward-only. Kept for local
-- teardown/re-apply cycles and to prove the migration is genuinely re-runnable.

DROP TRIGGER IF EXISTS mapping_template_frozen_trg ON import.mapping_template;
DROP TRIGGER IF EXISTS import_run_rollback_deadline_trg ON import.import_run;

DROP FUNCTION IF EXISTS import.reject_used_template_mutation();
DROP FUNCTION IF EXISTS import.stamp_rollback_deadline();

DROP TABLE IF EXISTS import.import_lineage;
DROP TABLE IF EXISTS import.import_exception;
DROP TABLE IF EXISTS import.import_run;
DROP TABLE IF EXISTS import.mapping_template;

DROP TYPE IF EXISTS import.lineage_action;
DROP TYPE IF EXISTS import.crosswalk_strategy;
DROP TYPE IF EXISTS import.mapping_template_kind;
DROP TYPE IF EXISTS import.import_run_status;

DROP SCHEMA IF EXISTS import CASCADE;
