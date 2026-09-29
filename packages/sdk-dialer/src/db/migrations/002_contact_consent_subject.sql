-- Migration 002: sdk-dialer — consent subject on campaign contacts. VA·E5 (TK-4481).
-- Auto-applied via api-gateway runMigrations.
--
-- The same person_id / jurisdiction pair a single API call carries, so a contact's call is
-- checked by the consent gate exactly like an API call (see voice_agent migration 008).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS); down in ../down/.
ALTER TABLE dialer.campaign_contact ADD COLUMN IF NOT EXISTS person_id UUID;
ALTER TABLE dialer.campaign_contact ADD COLUMN IF NOT EXISTS jurisdiction TEXT;
