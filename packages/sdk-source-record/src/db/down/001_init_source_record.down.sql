-- Rollback for 001_init_source_record.sql (sdk-source-record).
-- NOT auto-applied — the migration ledger is forward-only. Kept for local
-- teardown/re-apply cycles and for verifying the migration is genuinely re-runnable.
--
-- The immutability triggers block DELETE, not DROP TABLE, so dropping the schema
-- CASCADE is the correct teardown. Drop order is irrelevant under CASCADE, but the
-- explicit statements below document exactly what 001 owns.

DROP TRIGGER IF EXISTS id_crosswalk_immutable_trg ON source_record.id_crosswalk;
DROP TRIGGER IF EXISTS source_rights_attestation_immutable_trg
  ON source_record.source_rights_attestation;
DROP TRIGGER IF EXISTS source_assertion_immutable_trg ON source_record.source_assertion;
DROP TRIGGER IF EXISTS source_record_immutable_trg ON source_record.source_record;

DROP FUNCTION IF EXISTS source_record.reject_crosswalk_mutation();
DROP FUNCTION IF EXISTS source_record.reject_attestation_mutation();
DROP FUNCTION IF EXISTS source_record.reject_assertion_mutation();
DROP FUNCTION IF EXISTS source_record.reject_capture_mutation();

DROP TABLE IF EXISTS source_record.id_crosswalk;
DROP TABLE IF EXISTS source_record.source_rights_attestation;
DROP TABLE IF EXISTS source_record.source_assertion;
DROP TABLE IF EXISTS source_record.source_record;

DROP TYPE IF EXISTS source_record.evidence_kind;
DROP TYPE IF EXISTS source_record.assertion_status;
DROP TYPE IF EXISTS source_record.trust_state;
DROP TYPE IF EXISTS source_record.origin_class;

DROP SCHEMA IF EXISTS source_record CASCADE;
