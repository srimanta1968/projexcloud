-- Rollback for 005_history_retention.sql: restores 004's both-ways guard. Re-running
-- 004 is idempotent and does the same thing, so this exists for symmetry only.
DROP TRIGGER IF EXISTS assignment_history_append_only_trg ON assignment.assignment_history;
