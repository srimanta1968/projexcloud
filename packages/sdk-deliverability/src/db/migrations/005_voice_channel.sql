-- Migration 005: sdk-deliverability — 'voice' suppression channel. VA·E5 (TK-4481).
-- Auto-applied by the migration runner at boot.
--
-- AI phone calls need their own do-not-call list: a person can stop CALLS and still
-- want texts (and vice versa), and a national DNC import applies to calls. The dialer's
-- DNC gate checks the called number under 'voice', 'sms' and 'all' (TCPA DNC covers
-- both calls and texts, so an SMS opt-out also stops calls).
--
-- Only the CHECK constraints widen; existing rows are untouched. Idempotent; down in ../down/.
ALTER TABLE deliverability.suppression DROP CONSTRAINT IF EXISTS suppression_channel_check;
ALTER TABLE deliverability.suppression
  ADD CONSTRAINT suppression_channel_check CHECK (channel IN ('email','sms','voice','all'));
ALTER TABLE deliverability.optout_token DROP CONSTRAINT IF EXISTS optout_token_channel_check;
ALTER TABLE deliverability.optout_token
  ADD CONSTRAINT optout_token_channel_check CHECK (channel IN ('email','sms','voice','all'));
