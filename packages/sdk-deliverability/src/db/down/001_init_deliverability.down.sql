-- Rollback for 001_init_deliverability.sql (TK-3623).
--
-- NOT auto-applied: the migration runner globs only ../migrations/*.sql and is
-- forward-only. Defined here for manual / tooling rollback. Idempotent
-- (IF EXISTS), reverse dependency order; CASCADE removes dependent indexes.

DROP TABLE IF EXISTS deliverability.optout_event CASCADE;
DROP TABLE IF EXISTS deliverability.optout_token CASCADE;
DROP TABLE IF EXISTS deliverability.suppression  CASCADE;

DROP SCHEMA IF EXISTS deliverability RESTRICT;
