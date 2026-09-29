-- Migration 003: sdk-consent — AI voice consent purposes (VA·E8 · TK-4507).
-- Auto-applied by the migration runner at boot. ADDITIVE + idempotent.
--
-- Consent receipts reference a purpose by FK, so these two must exist before any tenant
-- can grant or check them:
--
--   ai_voice_outbound  receive outbound calls placed by an AI voice agent — the sdk-dialer
--                      consent gate refuses an outbound AI call without an active receipt
--   call_recording     have calls with an AI voice agent recorded — the sdk-dialer
--                      recording gate needs it wherever the all-party rule applies
--
-- Previously registered only by sdk-dialer at gateway boot (ensureVoiceConsentPurposes,
-- which stays as a no-op safety net); seeding them here makes them part of sdk-consent's
-- own schema, present on every deployment regardless of which SDKs are mounted.
-- ON CONFLICT DO NOTHING leaves a purpose that already exists exactly as it is.

INSERT INTO consent.purpose (purpose_id, app_id, description, legal_basis, default_jurisdictions, category, segmented)
VALUES
  ('ai_voice_outbound', 'projexcloud-voice', 'Receive outbound phone calls placed by an AI voice agent.', 'consent', '{}'::text[], 'general', false),
  ('call_recording',    'projexcloud-voice', 'Have phone calls with an AI voice agent recorded.',        'consent', '{}'::text[], 'general', false)
ON CONFLICT (purpose_id) DO NOTHING;
