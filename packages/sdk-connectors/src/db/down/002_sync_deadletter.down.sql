-- Rollback for 002_sync_deadletter.sql (P15·E5).
--
-- NOT auto-applied (runner is forward-only). Idempotent. Drops only the
-- sync_deadletter table 002 added; the connectors schema + 001 tables are intact.

DROP TABLE IF EXISTS connectors.sync_deadletter CASCADE;
