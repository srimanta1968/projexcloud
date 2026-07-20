-- Migration 003: sdk-offer-catalog — publish gate (approval before activation).
-- P15 · E1 (TK-3642). Auto-applied at boot. Additive + idempotent.
--
-- Tracks the sdk-approval state of an offer_version's publish request. Activation is
-- blocked while status is 'pending' or 'rejected'; 'not_required' (default) and 'approved'
-- allow it. The approval subject is the offer_version_id.

ALTER TABLE offer_catalog.offer_version
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'not_required'
    CHECK (approval_status IN ('not_required','pending','approved','rejected'));
ALTER TABLE offer_catalog.offer_version
  ADD COLUMN IF NOT EXISTS approval_ref TEXT;
ALTER TABLE offer_catalog.offer_version
  ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
ALTER TABLE offer_catalog.offer_version
  ADD COLUMN IF NOT EXISTS approval_decided_at TIMESTAMPTZ;

COMMENT ON COLUMN offer_catalog.offer_version.approval_status IS 'Publish-gate state: not_required (default) -> pending -> approved/rejected. Activation blocked while pending/rejected.';
