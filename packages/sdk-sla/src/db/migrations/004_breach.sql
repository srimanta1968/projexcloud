-- Migration 004: sdk-sla — breach records and systemic grouping (P16 · EP-376 · PCF-03-4).
--
--   breach_reason      — the tenant's cause taxonomy, discovered from use
--   breach_record      — one governed record per missed promise: WHY, and what was
--                        done about it
--   systemic_incident  — the grouping that makes a systemic breach open ONE
--                        incident rather than one per breach or one per rung
--
-- TWO SEPARATE FACTS, DELIBERATELY NOT ONE TABLE:
--   the clock's state going to 'breached' is arithmetic — the deadline passed, and
--   a scanner can assert that without knowing anything;
--   the breach RECORD is governance — it carries a cause and a recovery, and it
--   requires somebody who actually knows. Merging them would force the scanner to
--   invent a reason code, and an invented cause is worse than a missing one
--   because it looks like an answer. A breached clock with no record shows up in
--   attainment as a cause not yet recorded: visible debt.
--
-- Idempotent + re-runnable; rollback in ../down/004_breach.down.sql.

CREATE SCHEMA IF NOT EXISTS sla;

-- ========================================================= breach_reason
/*
 * The cause taxonomy is per tenant and NOT an enum: a platform enum would mean
 * every vertical shares one vocabulary for why it missed, which is exactly the
 * kind of business rule this package must not hold. Codes are auto-registered on
 * first use so a breach is never lost to an unconfigured taxonomy, and the
 * auto-registered ones are flagged so an operator can see which vocabulary grew
 * by accident rather than by decision.
 */
CREATE TABLE IF NOT EXISTS sla.breach_reason (
  reason_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  code         TEXT NOT NULL CHECK (length(btrim(code)) > 0),
  label        TEXT,
  -- Free grouping ('capacity', 'process', 'external'); the tenant's own axis.
  category     TEXT,
  is_auto_registered BOOLEAN NOT NULL DEFAULT false,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

DROP TRIGGER IF EXISTS breach_reason_touch_trg ON sla.breach_reason;
CREATE TRIGGER breach_reason_touch_trg
  BEFORE UPDATE ON sla.breach_reason
  FOR EACH ROW EXECUTE FUNCTION sla.touch_updated_at();

-- ===================================================== systemic_incident
/*
 * One incident per systemic GROUP.
 *
 * A single clock's ladder can fire four rungs, and twenty clocks can miss for the
 * same reason in the same hour. Either way the on-call engineer needs one
 * incident, not twenty-four. group_key is what "the same problem" means —
 * computed by the service from policy + reason + window — and the UNIQUE on it is
 * what makes opening the incident idempotent under concurrency.
 */
CREATE TABLE IF NOT EXISTS sla.systemic_incident (
  systemic_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  group_key    TEXT NOT NULL,
  -- NULL while no incident opener is wired or the last attempt failed; the record
  -- still exists, so the retry has something to find.
  incident_ref TEXT,
  incident_error TEXT,
  breach_count INTEGER NOT NULL DEFAULT 1 CHECK (breach_count > 0),
  first_breach_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_breach_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, group_key)
);

CREATE INDEX IF NOT EXISTS systemic_incident_pending_idx
  ON sla.systemic_incident (tenant_id, created_at)
  WHERE incident_ref IS NULL;

DROP TRIGGER IF EXISTS systemic_incident_touch_trg ON sla.systemic_incident;
CREATE TRIGGER systemic_incident_touch_trg
  BEFORE UPDATE ON sla.systemic_incident
  FOR EACH ROW EXECUTE FUNCTION sla.touch_updated_at();

-- ========================================================= breach_record
CREATE TABLE IF NOT EXISTS sla.breach_record (
  breach_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  clock_id     UUID NOT NULL REFERENCES sla.sla_clock (clock_id) ON DELETE RESTRICT,
  policy_id    UUID NOT NULL REFERENCES sla.sla_policy (policy_id) ON DELETE RESTRICT,
  -- Denormalised so an attainment breakdown does not have to join a clock that
  -- may since have been reassigned. These are the values AT BREACH TIME.
  subject_ref  TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  owner_ref    TEXT,
  -- Where the signal came from, for the by-source breakdown.
  source_ref   TEXT,
  due_at       TIMESTAMPTZ NOT NULL,
  breached_at  TIMESTAMPTZ NOT NULL,
  -- Measured in BUSINESS minutes on the policy calendar, which is the only
  -- measure that means anything on a business clock.
  elapsed_business_minutes INTEGER NOT NULL CHECK (elapsed_business_minutes >= 0),
  overdue_business_minutes INTEGER NOT NULL CHECK (overdue_business_minutes >= 0),
  -- MANDATORY. NOT NULL and non-blank: a breach with no stated cause is a number
  -- on a dashboard that nobody can act on.
  reason_code  TEXT NOT NULL CHECK (length(btrim(reason_code)) > 0),
  reason_detail TEXT,
  -- What was actually done. Unknown at recording time is legitimate; fabricated
  -- is not, so these stay NULL until somebody records the recovery.
  recovery_action TEXT,
  recovered_by TEXT,
  recovered_at TIMESTAMPTZ,
  is_systemic  BOOLEAN NOT NULL DEFAULT false,
  systemic_id  UUID REFERENCES sla.systemic_incident (systemic_id) ON DELETE RESTRICT,
  recorded_by  TEXT,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One breach per clock. A clock misses its deadline once; a second miss is a
  -- second promise, which is a second clock.
  CONSTRAINT breach_record_one_per_clock UNIQUE (clock_id),
  CONSTRAINT breach_record_recovery_complete CHECK (
    (recovery_action IS NULL AND recovered_at IS NULL)
    OR (recovery_action IS NOT NULL AND recovered_at IS NOT NULL)
  ),
  CONSTRAINT breach_record_systemic_grouped CHECK (
    NOT is_systemic OR systemic_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS breach_record_window_idx
  ON sla.breach_record (tenant_id, breached_at DESC);
CREATE INDEX IF NOT EXISTS breach_record_reason_idx
  ON sla.breach_record (tenant_id, reason_code);
CREATE INDEX IF NOT EXISTS breach_record_owner_idx
  ON sla.breach_record (tenant_id, owner_ref)
  WHERE owner_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS breach_record_unrecovered_idx
  ON sla.breach_record (tenant_id, breached_at)
  WHERE recovery_action IS NULL;

/*
 * The cause is immutable; the recovery is not.
 *
 * A reason code that can be edited later is a reason code that gets edited later,
 * and an attainment history that rewrites its own causes cannot be used to argue
 * for anything. Recording the recovery — which genuinely happens after the fact —
 * stays open, and correcting a genuinely wrong cause means a new record with the
 * old one referenced, not a quiet overwrite.
 */
CREATE OR REPLACE FUNCTION sla.reject_breach_cause_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reason_code IS DISTINCT FROM OLD.reason_code THEN
    RAISE EXCEPTION
      'breach_record % reason_code is immutable — an attainment history that rewrites its own causes cannot be used to argue for anything', OLD.breach_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.breached_at IS DISTINCT FROM OLD.breached_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at
     OR NEW.clock_id IS DISTINCT FROM OLD.clock_id THEN
    RAISE EXCEPTION 'breach_record % timing and clock reference are immutable', OLD.breach_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS breach_record_cause_immutable_trg ON sla.breach_record;
CREATE TRIGGER breach_record_cause_immutable_trg
  BEFORE UPDATE ON sla.breach_record
  FOR EACH ROW EXECUTE FUNCTION sla.reject_breach_cause_change();
