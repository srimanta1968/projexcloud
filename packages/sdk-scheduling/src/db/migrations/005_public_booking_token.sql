-- Migration 005: sdk-scheduling — public booking token. P14 · E2 (TK-3620).
-- Auto-applied by the migration runner at boot.
--
-- The public booking flow is ANONYMOUS: the invitee has no tenant JWT. An
-- unauthenticated caller must therefore never act on a raw appointment_id —
-- those are sequential-ish UUIDs handed out across the whole tenant, so allowing
-- confirm/cancel by id would be an IDOR: guess an id, cancel a stranger's
-- meeting. public_token is a high-entropy capability handed ONLY to the person
-- who made the booking, and it is the sole key the public confirm/cancel routes
-- accept.
--
-- Nullable: appointments booked through the authenticated API have no public
-- token, and UNIQUE tolerates many NULLs.
--
-- ADDITIVE + idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.

ALTER TABLE scheduling.appointment
  ADD COLUMN IF NOT EXISTS public_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS appointment_public_token_uidx
  ON scheduling.appointment (public_token) WHERE public_token IS NOT NULL;

COMMENT ON COLUMN scheduling.appointment.public_token IS
  'High-entropy capability token for anonymous confirm/cancel of a publicly booked appointment. Null for appointments created through the authenticated API.';
