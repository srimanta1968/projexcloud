-- Migration 004: website / chat as a lead-form platform (P16 · EP-386).
--
-- The website form and the site chat widget deliver the same KIND of thing as a paid-social
-- lead form — a completed intent signal with consent attached — so they reuse the same
-- archive, the same signature contract and the same idempotency key rather than getting a
-- parallel table. A second table would mean a second place for the archive-first ordering
-- and the replay guarantee to be got subtly wrong.
--
-- Widening a CHECK is done as DROP + ADD because Postgres has no ALTER CONSTRAINT for the
-- predicate; the ADD re-validates every existing row, which is exactly the safety we want
-- when changing what the column is allowed to hold.

ALTER TABLE connectors.lead_form_event
  DROP CONSTRAINT IF EXISTS lead_form_event_platform_check;

ALTER TABLE connectors.lead_form_event
  ADD CONSTRAINT lead_form_event_platform_check
  CHECK (platform IN ('META', 'LINKEDIN', 'TIKTOK', 'GOOGLE', 'WEBSITE'));

COMMENT ON COLUMN connectors.lead_form_event.platform IS
  'Source platform. WEBSITE covers first-party site forms and the chat widget, which share the social contract.';
