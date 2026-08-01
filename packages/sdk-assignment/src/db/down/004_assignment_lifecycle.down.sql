-- Rollback for 004_assignment_lifecycle.sql (sdk-assignment). NOT auto-applied.
DROP TABLE IF EXISTS assignment.assignment_history;
DROP TABLE IF EXISTS assignment.assignment_record;
DROP FUNCTION IF EXISTS assignment.reject_history_mutation();
DROP FUNCTION IF EXISTS assignment.protect_assignment_provenance();
DROP TYPE IF EXISTS assignment.assignment_state;
