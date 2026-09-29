-- Rollback for 002_contact_consent_subject.sql. NOT auto-applied.
ALTER TABLE dialer.campaign_contact DROP COLUMN IF EXISTS jurisdiction;
ALTER TABLE dialer.campaign_contact DROP COLUMN IF EXISTS person_id;
