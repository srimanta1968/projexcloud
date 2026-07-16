-- Rollback for 001_init_sequence.sql (TK-3612).
--
-- NOT auto-applied: the migration runner globs only ../migrations/*.sql and is
-- forward-only. This file is the DEFINED down-migration for manual / tooling
-- rollback of the sdk-sequence schema. It is idempotent (IF EXISTS) and drops
-- in reverse dependency order; CASCADE removes the dependent indexes.

DROP TABLE IF EXISTS sequence.trigger        CASCADE;
DROP TABLE IF EXISTS sequence.execution_step CASCADE;
DROP TABLE IF EXISTS sequence.step           CASCADE;
DROP TABLE IF EXISTS sequence.sequence       CASCADE;
DROP TABLE IF EXISTS sequence.template       CASCADE;

-- Drop the schema only if no other objects remain in it.
DROP SCHEMA IF EXISTS sequence RESTRICT;
