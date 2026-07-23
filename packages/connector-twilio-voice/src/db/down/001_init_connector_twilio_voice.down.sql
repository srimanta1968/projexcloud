-- Down for 001_init_connector_twilio_voice.sql (P15 · E4, TK-3652).
-- voice_call first: it FKs tracking_number.

DROP TABLE IF EXISTS connector_twilio_voice.voice_call;
DROP TABLE IF EXISTS connector_twilio_voice.tracking_number;
DROP SCHEMA IF EXISTS connector_twilio_voice CASCADE;
