-- Rollback for 001_init_scheduling.sql (sdk-scheduling, P14·E2 / TK-3618).
-- NOT auto-applied — the boot migration runner is forward-only. Drop child tables
-- (FK-dependent) before parents, then the schema.
DROP TABLE IF EXISTS scheduling.scheduling_link;
DROP TABLE IF EXISTS scheduling.appointment;
DROP TABLE IF EXISTS scheduling.availability_rule;
DROP TABLE IF EXISTS scheduling.meeting_type;
DROP SCHEMA IF EXISTS scheduling CASCADE;
