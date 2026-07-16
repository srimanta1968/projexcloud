-- Rollback for 001_init_handoff.sql (P15·E2).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent.

DROP TABLE IF EXISTS handoff.handoff CASCADE;
DROP SCHEMA IF EXISTS handoff RESTRICT;
