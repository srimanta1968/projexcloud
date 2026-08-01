-- Migration 006: a next action belongs to any SUBJECT, not only a deal (P16 · EP-380 · PCF-07-1).
--
-- 004 tied next_action to crm.deal with a NOT NULL foreign key. That was right for a
-- pipeline and wrong for everything else: a lead nobody has qualified yet, a contact
-- with an open question, a ticket waiting on a customer all need the same discipline —
-- somebody owns it, by a specific time, for a stated reason. Verticals that lacked a
-- deal either invented a placeholder one (polluting the pipeline with rows that were
-- never opportunities) or skipped the discipline entirely.
--
-- ADDITIVE AND BACKWARD COMPATIBLE. deal_id stays and keeps its foreign key; it simply
-- becomes optional, and every existing row is backfilled with the equivalent
-- subject_ref so old and new readers see the same fact. Nothing deal-scoped changes.
--
-- Idempotent; rollback in ../down/006_subject_next_action.down.sql.

ALTER TABLE crm.next_action ADD COLUMN IF NOT EXISTS subject_ref TEXT;
ALTER TABLE crm.next_action ADD COLUMN IF NOT EXISTS subject_kind TEXT;
/*
 * WHY intended_outcome IS SEPARATE FROM purpose. "Follow up on pricing" is a purpose;
 * "they confirm the discount is enough to sign this quarter" is what has to be true
 * afterwards for the action to have been worth doing. Without the second, an action is
 * marked complete because it HAPPENED, and a queue of things that happened is not
 * progress.
 */
ALTER TABLE crm.next_action ADD COLUMN IF NOT EXISTS intended_outcome TEXT;

-- Backfill BEFORE relaxing the constraint, so no row is ever without an identity.
UPDATE crm.next_action
   SET subject_ref = 'deal:' || deal_id::text,
       subject_kind = 'deal'
 WHERE subject_ref IS NULL AND deal_id IS NOT NULL;

ALTER TABLE crm.next_action ALTER COLUMN deal_id DROP NOT NULL;

-- Every action names something. Either the legacy deal FK or the generic ref will do,
-- but a row with neither belongs to nobody and can never be found again.
DO $$ BEGIN
  ALTER TABLE crm.next_action
    ADD CONSTRAINT next_action_has_a_subject CHECK (
      deal_id IS NOT NULL OR (subject_ref IS NOT NULL AND length(btrim(subject_ref)) > 0)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS next_action_subject_idx
  ON crm.next_action (tenant_id, subject_ref);
-- ONE open action per subject: two "next" actions mean there is no next action, just a
-- list, and the whole point is a single committed next step.
CREATE UNIQUE INDEX IF NOT EXISTS next_action_one_open_per_subject_idx
  ON crm.next_action (tenant_id, subject_ref)
  WHERE status = 'open' AND subject_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS next_action_overdue_idx
  ON crm.next_action (tenant_id, due_at)
  WHERE status = 'open';
