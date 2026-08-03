-- Rollback for 001_init_data_credits.sql (sdk-data-credits). NOT auto-applied — forward-only.
-- Dropped child-first: provider_attempt and credit_ledger reference the request and
-- the reservation, which reference the capability.
DROP TABLE IF EXISTS data_credits.provider_attempt;
DROP TABLE IF EXISTS data_credits.credit_ledger;
DROP TABLE IF EXISTS data_credits.budget_policy;
DROP TABLE IF EXISTS data_credits.result_cache;
DROP TABLE IF EXISTS data_credits.reservation;
DROP TABLE IF EXISTS data_credits.capability_request;
DROP TABLE IF EXISTS data_credits.credit_account;
DROP TABLE IF EXISTS data_credits.provider_binding;
DROP TABLE IF EXISTS data_credits.capability;
DROP FUNCTION IF EXISTS data_credits.reject_ledger_mutation();
DROP FUNCTION IF EXISTS data_credits.derive_cache_expiry();
DROP FUNCTION IF EXISTS data_credits.reject_resettlement();
DROP FUNCTION IF EXISTS data_credits.touch_updated_at();
DROP TYPE IF EXISTS data_credits.ledger_entry_type;
DROP TYPE IF EXISTS data_credits.budget_mode;
DROP TYPE IF EXISTS data_credits.provider_health;
DROP TYPE IF EXISTS data_credits.request_status;
DROP TYPE IF EXISTS data_credits.settlement_outcome;
DROP SCHEMA IF EXISTS data_credits;
