-- Rollback for 001_init_dialer.sql. NOT auto-applied.
DROP TABLE IF EXISTS dialer.dispatch_queue;
DROP TABLE IF EXISTS dialer.campaign_contact;
DROP TABLE IF EXISTS dialer.campaign;
DROP SCHEMA IF EXISTS dialer;
