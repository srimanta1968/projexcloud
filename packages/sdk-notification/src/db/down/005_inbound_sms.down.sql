-- Rollback for 005_inbound_sms.sql (sdk-notification, P14·E4 / TK-3634). Not auto-applied.
DROP TABLE IF EXISTS notification.sms_inbound;
DROP TABLE IF EXISTS notification.sms_settings;
