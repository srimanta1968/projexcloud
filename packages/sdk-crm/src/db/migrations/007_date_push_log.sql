-- Migration 007: date-push governance (P16 · EP-380 · PCF-07-2).
--
--   date_push_log  — every due-date move, with the reason, append-only
--   push_count     — the same fact on the subject, so the PATTERN is visible
--
-- WHY BOTH. A due date that moves is normal. A due date that moves five times is a
-- commitment nobody intends to keep, and the difference is invisible if the moves only
-- live in a log nobody opens. The count sits on the row a person is looking at when
-- they push it again — which is the moment the pattern needs to be in front of them,
-- not in a report at the end of the quarter.
--
-- Idempotent + additive; rollback in ../down/007_date_push_log.down.sql.

ALTER TABLE crm.next_action
  ADD COLUMN IF NOT EXISTS push_count INTEGER NOT NULL DEFAULT 0
    CHECK (push_count >= 0);
-- The date originally committed to. Frozen by the trigger below: without it, "pushed
-- four times" says nothing about how far the commitment has actually slipped.
ALTER TABLE crm.next_action
  ADD COLUMN IF NOT EXISTS original_due_at TIMESTAMPTZ;

UPDATE crm.next_action SET original_due_at = due_at WHERE original_due_at IS NULL;

CREATE TABLE IF NOT EXISTS crm.date_push_log (
  push_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  next_action_id UUID NOT NULL
    REFERENCES crm.next_action (next_action_id) ON DELETE CASCADE,
  subject_ref  TEXT,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  from_due_at  TIMESTAMPTZ NOT NULL,
  to_due_at    TIMESTAMPTZ NOT NULL,
  /*
   * REQUIRED, by constraint. A push with no reason is the whole problem in miniature:
   * the date moves, everyone forgets, and the pattern only surfaces when somebody asks
   * why a quarter closed short. Demanding a sentence is also the cheapest possible
   * friction against pushing reflexively.
   */
  reason       TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  /** Set when a manager authorised a push past the threshold. */
  approved_by  TEXT,
  pushed_by    TEXT,
  pushed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Moving a date to itself is not a push; it is a no-op somebody logged.
  CONSTRAINT date_push_log_actually_moved CHECK (to_due_at <> from_due_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS date_push_log_seq_idx
  ON crm.date_push_log (next_action_id, seq);
CREATE INDEX IF NOT EXISTS date_push_log_subject_idx
  ON crm.date_push_log (tenant_id, subject_ref, pushed_at DESC);

/*
 * Append-only in the EDIT sense: an entry can never be rewritten, because a push log
 * whose reasons can be tidied up afterwards is worth nothing. It CAN be removed with
 * the action it describes (ON DELETE CASCADE), which is a retention decision — the
 * mistake sdk-assignment's 004 made and 005 had to undo.
 */
CREATE OR REPLACE FUNCTION crm.reject_push_log_edit()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'crm.date_push_log entry % records a due-date move that happened and cannot be rewritten',
    OLD.push_id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS date_push_log_append_only_trg ON crm.date_push_log;
CREATE TRIGGER date_push_log_append_only_trg
  BEFORE UPDATE ON crm.date_push_log
  FOR EACH ROW EXECUTE FUNCTION crm.reject_push_log_edit();

/**
 * The first commitment never moves, however many times the due date does.
 *
 * Stamped on INSERT rather than left to callers: every writer would have to remember,
 * and the one that forgets leaves a row where "pushed four times" cannot say how far
 * the date has actually slipped — which is the whole reason the column exists.
 */
CREATE OR REPLACE FUNCTION crm.freeze_original_due()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.original_due_at := COALESCE(NEW.original_due_at, NEW.due_at);
    RETURN NEW;
  END IF;
  IF OLD.original_due_at IS NOT NULL
     AND NEW.original_due_at IS DISTINCT FROM OLD.original_due_at THEN
    RAISE EXCEPTION
      'crm.next_action %: original_due_at is the date first committed to and cannot be moved',
      OLD.next_action_id USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS next_action_freeze_original_due_trg ON crm.next_action;
CREATE TRIGGER next_action_freeze_original_due_trg
  BEFORE INSERT OR UPDATE ON crm.next_action
  FOR EACH ROW EXECUTE FUNCTION crm.freeze_original_due();

/*
 * Escalation offsets, per tenant and configurable — not thresholds in code.
 * "Overdue by a day" means something different for a support ticket and a renewal, and
 * a constant in a service is a decision made for every tenant by whoever typed it.
 */
CREATE TABLE IF NOT EXISTS crm.overdue_policy (
  policy_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  subject_kind TEXT,
  /*
   * Ascending minutes past due, each with a level name:
   *   [{"minutes": 60, "level": "nudge"}, {"minutes": 1440, "level": "manager"}]
   */
  offsets      JSONB NOT NULL DEFAULT '[]'::jsonb,
  /** Pushes allowed before a manager reason is required. NULL = no ceiling. */
  push_threshold INTEGER CHECK (push_threshold IS NULL OR push_threshold >= 0),
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One policy per (tenant, kind). TOTAL rather than partial so an upsert can infer it;
-- a partial unique index makes ON CONFLICT fail at runtime.
CREATE UNIQUE INDEX IF NOT EXISTS overdue_policy_scope_idx
  ON crm.overdue_policy (tenant_id, COALESCE(subject_kind, ''));
