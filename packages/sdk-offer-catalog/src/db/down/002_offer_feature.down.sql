-- Rollback for 002_offer_feature.sql (P15·E1).
--
-- NOT auto-applied (runner is forward-only). Idempotent. Drops only the
-- offer_feature table 002 added; offer/offer_version (001) are left intact.

DROP TABLE IF EXISTS offer_catalog.offer_feature CASCADE;
