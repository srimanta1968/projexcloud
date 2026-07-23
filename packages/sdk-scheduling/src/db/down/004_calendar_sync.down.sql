-- Rollback for 004_calendar_sync.sql (sdk-scheduling, P14·E2 / TK-3622). Not auto-applied.
DROP TABLE IF EXISTS scheduling.calendar_sync_map;
DROP TABLE IF EXISTS scheduling.calendar_connection;
