-- Rollback for 003_publish_gate.sql (sdk-offer-catalog, P15·E1 / TK-3642). Not auto-applied.
ALTER TABLE offer_catalog.offer_version
  DROP COLUMN IF EXISTS approval_status,
  DROP COLUMN IF EXISTS approval_ref,
  DROP COLUMN IF EXISTS approval_requested_at,
  DROP COLUMN IF EXISTS approval_decided_at;
