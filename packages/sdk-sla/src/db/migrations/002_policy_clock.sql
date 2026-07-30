-- Migration 002: sdk-sla — policies and clocks (P16 · EP-376 / PCF-03-2).
--
--   sla_policy — what promise applies to which subjects, for how long, on which
--                calendar, and what counts as satisfying it
--   sla_clock  — one running promise about one subject
--
-- THE SOURCE TIMESTAMP IS THE POINT OF THIS TABLE. source_timestamp is when the
-- SIGNAL happened — the message arrived, the form was submitted — not when the
-- platform got around to creating a clock for it. It is immutable, and so are
-- started_at and due_at, because the events that most tempt a system to reset
-- them (a merge, a reassignment, a backup owner taking over) are exactly the
-- events where resetting would erase the wait the person on the other end has
-- already experienced. A trigger enforces that; see the bottom of this file.
--
-- Idempotent + re-runnable; rollback in ../down/002_policy_clock.down.sql.

CREATE SCHEMA IF NOT EXISTS sla;

DO $$ BEGIN
  CREATE TYPE sla.clock_state AS ENUM (
    'running',
    'paused',
    'satisfied',
    'breached',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================ sla_policy
CREATE TABLE IF NOT EXISTS sla.sla_policy (
  policy_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  slug         TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  -- What the promise is about: a loose kind string, because the subject lives in
  -- whichever SDK raised it and this one must not depend on all of them.
  subject_kind TEXT NOT NULL,
  /*
   * Qualifying predicate: which subjects this policy applies to, as DATA.
   *   { "all": [ { "field": "priority", "op": "in", "value": ["high"] } ] }
   * A predicate rather than code so a vertical narrows a promise without a
   * platform change.
   */
  qualifying_predicate JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  calendar_id  UUID NOT NULL REFERENCES sla.business_calendar (calendar_id) ON DELETE RESTRICT,
  /*
   * Conditions that pause the clock, as data:
   *   [ { "reason": "awaiting_subject_reply", "max_minutes": 4320 } ]
   * max_minutes caps a pause so a clock cannot be parked indefinitely to dodge a
   * breach — the most common way an SLA is gamed.
   */
  pause_conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  /*
   * The satisfaction contract: what evidence actually closes this promise.
   *   { "requires_evidence_ref": true,
   *     "accepted_kinds": ["outbound_reply","resolution"],
   *     "min_evidence_count": 1 }
   * Without this, "satisfied" degrades into whatever the closing service felt
   * like asserting, and the metric stops meaning anything.
   */
  satisfaction_contract JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS sla_policy_tenant_subject_idx
  ON sla.sla_policy (tenant_id, subject_kind, is_active);

DROP TRIGGER IF EXISTS sla_policy_touch_trg ON sla.sla_policy;
CREATE TRIGGER sla_policy_touch_trg
  BEFORE UPDATE ON sla.sla_policy
  FOR EACH ROW EXECUTE FUNCTION sla.touch_updated_at();

-- ============================================================= sla_clock
CREATE TABLE IF NOT EXISTS sla.sla_clock (
  clock_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  policy_id    UUID NOT NULL REFERENCES sla.sla_policy (policy_id) ON DELETE RESTRICT,
  -- Loose ref to whatever the promise is about.
  subject_ref  TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  -- WHEN THE SIGNAL HAPPENED. Immutable. Not when the row was created.
  source_timestamp TIMESTAMPTZ NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at       TIMESTAMPTZ NOT NULL,
  state        sla.clock_state NOT NULL DEFAULT 'running',
  -- Who owns the response now. THIS may change freely — that is the difference
  -- between the clock's timing (frozen) and its ownership (fluid).
  owner_ref    TEXT,
  /*
   * Closed pause intervals: [{"from":"...","to":"...","reason":"..."}].
   * The open pause, if any, is paused_at + pause_reason. Elapsed business minutes
   * subtract these, which is what makes a pause meaningful rather than cosmetic.
   */
  paused_intervals JSONB NOT NULL DEFAULT '[]'::jsonb,
  paused_at    TIMESTAMPTZ,
  pause_reason TEXT,
  satisfied_at TIMESTAMPTZ,
  satisfied_by_evidence_ref TEXT,
  satisfied_by TEXT,
  breached_at  TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  -- Set when a merge folded another subject's clock into this one, so the
  -- surviving clock still names what it absorbed.
  merged_from_ref TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One live clock per (policy, subject): a second one would double-count the
  -- same promise and fire the ladder twice.
  CONSTRAINT sla_clock_state_timestamps CHECK (
    (state <> 'satisfied' OR satisfied_at IS NOT NULL)
    AND (state <> 'breached' OR breached_at IS NOT NULL)
    AND (state <> 'cancelled' OR cancelled_at IS NOT NULL)
    AND (state <> 'paused' OR paused_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS sla_clock_live_unique_idx
  ON sla.sla_clock (tenant_id, policy_id, subject_ref)
  WHERE state IN ('running', 'paused');

CREATE INDEX IF NOT EXISTS sla_clock_due_idx
  ON sla.sla_clock (tenant_id, due_at)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS sla_clock_subject_idx
  ON sla.sla_clock (tenant_id, subject_ref);
CREATE INDEX IF NOT EXISTS sla_clock_owner_idx
  ON sla.sla_clock (tenant_id, owner_ref)
  WHERE owner_ref IS NOT NULL;

/*
 * The timing columns are frozen for the life of the clock.
 *
 * A merge, a reassignment or a backup takeover all rewrite plenty about a
 * subject, and every one of them is a moment where a well-meaning service might
 * "refresh" the clock. Doing so restarts the promise and erases the wait the
 * person has already had — the SLA report then shows a fast response to a
 * request that actually sat for two days. Ownership moves; the clock does not.
 */
CREATE OR REPLACE FUNCTION sla.reject_clock_timing_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_timestamp IS DISTINCT FROM OLD.source_timestamp THEN
    RAISE EXCEPTION
      'sla_clock % source_timestamp is immutable — it is when the signal happened, not when the platform noticed', OLD.clock_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'sla_clock % started_at is immutable', OLD.clock_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION
      'sla_clock % due_at is immutable — extend the promise with a new policy rather than moving the goalposts', OLD.clock_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sla_clock_timing_immutable_trg ON sla.sla_clock;
CREATE TRIGGER sla_clock_timing_immutable_trg
  BEFORE UPDATE ON sla.sla_clock
  FOR EACH ROW EXECUTE FUNCTION sla.reject_clock_timing_change();
