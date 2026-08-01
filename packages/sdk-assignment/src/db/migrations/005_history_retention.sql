-- Migration 005: history is un-EDITABLE, not un-DELETABLE (P16 · EP-379 · PCF-06-2).
--
-- 004 refused both UPDATE and DELETE on assignment_history. The DELETE half was wrong,
-- and the tests found it immediately: assignment_history is ON DELETE CASCADE from
-- assignment_record, so the trigger fired on the cascade and made an assignment
-- UNDELETABLE the moment it had any history — which is always, because offering one
-- writes the first entry. A tenant offboarding, a retention policy or an erasure
-- request would each have been blocked by an audit rule that was never meant to
-- outrank them.
--
-- The distinction that matters is EDIT vs REMOVE. Rewriting an entry changes what
-- happened and is refused forever; removing an entire assignment along with its
-- history is a retention decision, made deliberately at the record level, where the
-- subject and its data live. An audit trail that cannot be deleted with the thing it
-- describes is not stricter, it just makes deletion someone else's problem.
--
-- Forward-only: 004 is already applied and sha-tracked, so this replaces the function
-- rather than editing it. Idempotent.

CREATE OR REPLACE FUNCTION assignment.reject_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Only UPDATE reaches here now; the trigger below no longer fires on DELETE.
  RAISE EXCEPTION
    'assignment_history entry % records what happened and cannot be rewritten — append a new entry instead',
    OLD.history_id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assignment_history_append_only_trg ON assignment.assignment_history;
CREATE TRIGGER assignment_history_append_only_trg
  BEFORE UPDATE ON assignment.assignment_history
  FOR EACH ROW EXECUTE FUNCTION assignment.reject_history_mutation();
