-- Rollback for 001_init_connector_telnyx_voice.sql. NOT auto-applied.
DROP TABLE IF EXISTS connector_telnyx_voice.webhook_event;
DROP TABLE IF EXISTS connector_telnyx_voice.voice_call;
DROP SCHEMA IF EXISTS connector_telnyx_voice;
