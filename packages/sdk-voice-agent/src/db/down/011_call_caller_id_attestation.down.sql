-- Rollback for 011_call_caller_id_attestation.sql. NOT auto-applied.
ALTER TABLE voice_agent.call DROP COLUMN IF EXISTS caller_id_attestation;
