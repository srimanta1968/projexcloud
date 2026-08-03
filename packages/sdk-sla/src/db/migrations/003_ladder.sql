-- Migration 003: sdk-sla — escalation ladder and the firing ledger (P16 · EP-376 · PCF-03-3).
--
--   ladder_rung  — WHAT escalates, WHEN, TO WHOM, and how loudly. Data, not code:
--                  a vertical adds a rung by inserting a row.
--   rung_firing  — the exactly-once ledger. One row per (clock, rung), ever.
--
-- THE UNIQUE INDEX ON (clock_id, rung_id) IS THE WHOLE IDEMPOTENCY GUARANTEE.
-- Two ticks running concurrently both decide the same rung is due; both try to
-- insert; exactly one wins and only that one executes the action. Nothing here
-- relies on a lock being held for the duration of a notification, because an
-- escalation that pages a person twice is worse than one that pages them a
-- second late.
--
-- Idempotent + re-runnable; rollback in ../down/003_ladder.down.sql.

CREATE SCHEMA IF NOT EXISTS sla;

DO $$ BEGIN
  CREATE TYPE sla.rung_severity AS ENUM (
    'info',
    'warning',
    'urgent',
    'critical'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  /*
   * claimed — a tick took the right to fire this rung and is executing it
   * fired   — the action completed. TERMINAL. A fired rung is never re-fired.
   * failed  — the action raised; eligible for retry, still exactly-once because
   *           the ledger row already exists and retry re-uses it.
   */
  CREATE TYPE sla.rung_firing_state AS ENUM (
    'claimed',
    'fired',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ========================================================== ladder_rung
CREATE TABLE IF NOT EXISTS sla.ladder_rung (
  rung_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  policy_id    UUID NOT NULL REFERENCES sla.sla_policy (policy_id) ON DELETE RESTRICT,
  -- Ladder order. Unique per policy so "rung 2" names one thing in a report.
  rung_index   INTEGER NOT NULL CHECK (rung_index >= 0),
  label        TEXT,
  /*
   * BUSINESS minutes from the clock's start — the same anchor and the same
   * arithmetic due_at uses, so a rung at offset = policy.duration_minutes fires
   * exactly at due, below that it is a warning and above it an escalation. One
   * anchor means a rung time and a due time can never disagree about the
   * calendar. createRung also accepts minutes_before_due / minutes_after_due and
   * normalises to this column at insert time.
   */
  offset_minutes INTEGER NOT NULL CHECK (offset_minutes >= 0),
  /*
   * WHO hears about it, resolved AT FIRE TIME rather than at configuration time:
   *   { "kind": "owner" }                              the current owner
   *   { "kind": "refs", "refs": ["persona:1"] }        a literal list
   *   { "kind": "on_call", "rotation_ref": "tier-1" }  resolved through the
   *                                                    on-call resolver
   * Late resolution is the point: the person on call at 02:00 is not the person
   * who was on call when somebody wrote the policy.
   */
  audience     JSONB NOT NULL DEFAULT '{"kind":"owner"}'::jsonb,
  severity     sla.rung_severity NOT NULL DEFAULT 'warning',
  /*
   * The action name, as data. Resolved through the handler registry the consuming
   * app populates (notify -> sdk-notification, reassign -> sdk-assignment,
   * open_incident -> sdk-incident). An action with no registered handler FAILS
   * the firing with a named error — it is never recorded as fired, because a
   * silent no-op escalation is indistinguishable from a working one until the
   * day it matters.
   */
  action       TEXT NOT NULL CHECK (length(btrim(action)) > 0),
  action_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What the recipient should DO. A page that says only "SLA at risk" wastes the
  -- one moment somebody is actually paying attention.
  remediation_hint TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, policy_id, rung_index)
);

CREATE INDEX IF NOT EXISTS ladder_rung_policy_idx
  ON sla.ladder_rung (tenant_id, policy_id, offset_minutes)
  WHERE is_active;

DROP TRIGGER IF EXISTS ladder_rung_touch_trg ON sla.ladder_rung;
CREATE TRIGGER ladder_rung_touch_trg
  BEFORE UPDATE ON sla.ladder_rung
  FOR EACH ROW EXECUTE FUNCTION sla.touch_updated_at();

-- ========================================================== rung_firing
CREATE TABLE IF NOT EXISTS sla.rung_firing (
  firing_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  clock_id     UUID NOT NULL REFERENCES sla.sla_clock (clock_id) ON DELETE RESTRICT,
  rung_id      UUID NOT NULL REFERENCES sla.ladder_rung (rung_id) ON DELETE RESTRICT,
  state        sla.rung_firing_state NOT NULL DEFAULT 'claimed',
  attempts     INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  -- The instant this rung became due, kept so a report can show whether the
  -- ladder ran late and by how much.
  fire_at      TIMESTAMPTZ NOT NULL,
  claimed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  fired_at     TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  last_error   TEXT,
  -- WHO it actually went to, at the moment it went. Resolving the audience again
  -- later would answer a different question.
  audience_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rung_firing_state_timestamps CHECK (
    (state <> 'fired'  OR fired_at  IS NOT NULL)
    AND (state <> 'failed' OR failed_at IS NOT NULL)
  ),
  -- EXACTLY ONCE. One firing row per rung per clock, forever.
  CONSTRAINT rung_firing_once UNIQUE (clock_id, rung_id)
);

CREATE INDEX IF NOT EXISTS rung_firing_retry_idx
  ON sla.rung_firing (tenant_id, next_attempt_at)
  WHERE state = 'failed';
CREATE INDEX IF NOT EXISTS rung_firing_stale_claim_idx
  ON sla.rung_firing (tenant_id, claimed_at)
  WHERE state = 'claimed';
CREATE INDEX IF NOT EXISTS rung_firing_clock_idx
  ON sla.rung_firing (clock_id);

/*
 * A fired rung can never be un-fired.
 *
 * Retry is a legitimate and necessary operation — a notification provider being
 * down must not cost the escalation. But retry must only ever touch a firing that
 * has NOT succeeded. If a bug (or a hand-run UPDATE) could move a row back out of
 * 'fired', "exactly once" would hold only as long as every caller was careful,
 * which is not a guarantee. This is.
 */
CREATE OR REPLACE FUNCTION sla.reject_unfiring()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state = 'fired' AND NEW.state IS DISTINCT FROM 'fired' THEN
    RAISE EXCEPTION
      'rung_firing % already fired — a fired rung cannot be re-armed; escalate with a new rung instead', OLD.firing_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'fired' AND NEW.fired_at IS DISTINCT FROM OLD.fired_at THEN
    RAISE EXCEPTION 'rung_firing % fired_at is immutable once fired', OLD.firing_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.clock_id IS DISTINCT FROM OLD.clock_id OR NEW.rung_id IS DISTINCT FROM OLD.rung_id THEN
    RAISE EXCEPTION 'rung_firing % cannot be re-pointed at another clock or rung', OLD.firing_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS rung_firing_no_unfire_trg ON sla.rung_firing;
CREATE TRIGGER rung_firing_no_unfire_trg
  BEFORE UPDATE ON sla.rung_firing
  FOR EACH ROW EXECUTE FUNCTION sla.reject_unfiring();
