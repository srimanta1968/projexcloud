-- Down for 005_public_booking_token.sql (P14 · E2, TK-3620).

DROP INDEX IF EXISTS scheduling.appointment_public_token_uidx;
ALTER TABLE scheduling.appointment DROP COLUMN IF EXISTS public_token;
