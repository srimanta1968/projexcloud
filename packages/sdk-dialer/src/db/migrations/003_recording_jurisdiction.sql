-- Migration 003: sdk-dialer — call-recording jurisdiction registry. VA·E5 (TK-4482).
-- Auto-applied via api-gateway runMigrations.
--
-- Whether an AI call may be RECORDED depends on where the recipient is:
--   one_party   one party to the call (the business) may consent — recording permitted;
--   all_party   every party must consent — permitted only with the recipient's
--               call_recording consent (sdk-consent);
--   prohibited  never record.
-- A country whose rule differs by state/province is marked varies_by_region: without a
-- region (US rather than US-CA) the STRICT rule applies, exactly as for a jurisdiction
-- that is not in this table at all. Recording never blocks the call itself — the dialer
-- stores the decision on the call (recording_consent) and the runtime obeys it.
--
-- Platform reference data (not tenant data): no tenant_id, no RLS. Seed rows are
-- inserted ON CONFLICT DO NOTHING, so an operator's later edits are never overwritten.
-- This seed is an engineering default, NOT legal advice; operators must review it.
--
-- Idempotent; down in ../down/.

CREATE TABLE IF NOT EXISTS dialer.recording_jurisdiction (
  jurisdiction      TEXT PRIMARY KEY,                -- ISO country, or country-region (US-CA)
  rule              TEXT NOT NULL CHECK (rule IN ('one_party','all_party','prohibited')),
  varies_by_region  BOOLEAN NOT NULL DEFAULT false,  -- country-level row whose regions differ
  notes             TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO dialer.recording_jurisdiction (jurisdiction, rule, varies_by_region, notes) VALUES
  ('US',    'one_party', true,  'Federal one-party (18 USC 2511); several states require all-party consent'),
  ('US-CA', 'all_party', false, 'California Penal Code 632'),
  ('US-CT', 'all_party', false, 'Connecticut (civil liability without consent)'),
  ('US-DE', 'all_party', false, NULL),
  ('US-FL', 'all_party', false, 'Florida Statutes 934.03'),
  ('US-IL', 'all_party', false, 'Illinois Eavesdropping Act'),
  ('US-MD', 'all_party', false, NULL),
  ('US-MA', 'all_party', false, NULL),
  ('US-MI', 'all_party', false, 'Treated as all-party (case law is mixed)'),
  ('US-MT', 'all_party', false, NULL),
  ('US-NV', 'all_party', false, 'Telephone recordings'),
  ('US-NH', 'all_party', false, NULL),
  ('US-OR', 'all_party', false, 'In-person conversations; treated strictly for calls'),
  ('US-PA', 'all_party', false, NULL),
  ('US-WA', 'all_party', false, NULL),
  ('CA',    'one_party', false, 'Canada Criminal Code s.184 (PIPEDA notice still applies)'),
  ('GB',    'one_party', false, 'Lawful for a party to record; UK GDPR transparency notice required'),
  ('IE',    'one_party', false, NULL),
  ('IN',    'one_party', false, NULL),
  ('AU',    'all_party', true,  'Varies by state; strict without a region'),
  ('DE',    'all_party', false, 'StGB 201'),
  ('FR',    'all_party', false, NULL),
  ('ES',    'one_party', false, NULL),
  ('IT',    'one_party', false, NULL),
  ('NL',    'one_party', false, NULL)
ON CONFLICT (jurisdiction) DO NOTHING;

COMMENT ON TABLE dialer.recording_jurisdiction IS 'Call-recording consent rule per jurisdiction; unknown or region-less varies_by_region entries use the strict all_party rule.';
