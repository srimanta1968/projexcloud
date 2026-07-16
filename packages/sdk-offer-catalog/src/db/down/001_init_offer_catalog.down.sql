-- Rollback for 001_init_offer_catalog.sql (P15·E1).
--
-- NOT auto-applied (runner is forward-only, globs only ../migrations/*.sql).
-- Idempotent; reverse dependency order (offer_version references offer).

DROP TABLE IF EXISTS offer_catalog.offer_version CASCADE;
DROP TABLE IF EXISTS offer_catalog.offer         CASCADE;

DROP SCHEMA IF EXISTS offer_catalog RESTRICT;
