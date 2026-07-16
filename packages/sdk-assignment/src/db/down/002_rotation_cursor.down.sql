-- Rollback for 002_rotation_cursor.sql (EP-335).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent. Drops only the rotation_cursor table 002 added; the assignment
-- schema and its 001 tables are left intact.

DROP TABLE IF EXISTS assignment.rotation_cursor CASCADE;
