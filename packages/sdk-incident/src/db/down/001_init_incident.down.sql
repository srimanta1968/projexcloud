-- Rollback for 001_init_incident.sql (P15·E3).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent.

DROP TABLE IF EXISTS incident.incident CASCADE;
DROP SCHEMA IF EXISTS incident RESTRICT;
