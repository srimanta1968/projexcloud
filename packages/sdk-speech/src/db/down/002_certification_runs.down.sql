-- Rollback for 002_certification_runs.sql (VA·E10, TK-4519). NOT auto-applied. Idempotent.
DROP TABLE IF EXISTS speech.tenant_certification CASCADE;
DROP TABLE IF EXISTS speech.certification_run CASCADE;
