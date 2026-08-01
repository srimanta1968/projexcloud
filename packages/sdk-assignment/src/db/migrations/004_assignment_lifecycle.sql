-- Migration 004: the assignment lifecycle and its history (P16 · EP-379 · PCF-06-2).
--
--   assignment_record   — primary + backup + manager, with the SOURCE TIMESTAMP frozen
--   assignment_history  — every prior owner and the reason they stopped being one
--
-- THE INVARIANT THIS TABLE EXISTS FOR. `source_timestamp` is when the WORLD produced
-- the subject — the moment somebody actually asked. Every SLA in the platform is
-- measured from it. A reassignment, a decline, a fallback or a manager takeover moves
-- OWNERSHIP; it does not move that instant. Left mutable, every transfer silently
-- resets the clock, so a subject that has been waiting six hours reads as fresh and
-- the breach report says everything is fine. The trigger below refuses the change
-- rather than trusting six services to remember.
--
-- Idempotent + additive; rollback in ../down/004_assignment_lifecycle.down.sql.

DO $$ BEGIN
  CREATE TYPE assignment.assignment_state AS ENUM (
    'OFFERED',
    'ACCEPTED',
    'DECLINED',
    'REASSIGNED',
    'FELL_BACK',
    'COMPLETED',
    'CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS assignment.assignment_record (
  record_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- What is being assigned. A loose ref: the subject belongs to the caller.
  subject_ref  TEXT NOT NULL,
  /*
   * WHEN THE WORLD PRODUCED IT. Not when we recorded it, not when it was last
   * reassigned. Frozen by trigger, forever.
   */
  source_timestamp TIMESTAMPTZ NOT NULL,
  /*
   * WHO IT WAS FIRST. Also frozen: "who originally owned this" stops being answerable
   * the moment it is overwritten by the current owner, and that is the question every
   * escalation asks.
   */
  original_persona_id UUID NOT NULL,
  primary_persona_id  UUID NOT NULL,
  backup_persona_id   UUID,
  manager_persona_id  UUID,
  state        assignment.assignment_state NOT NULL DEFAULT 'OFFERED',
  offered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at  TIMESTAMPTZ,
  closed_at    TIMESTAMPTZ,
  -- How long the primary has to accept before it falls to the backup.
  acceptance_window_minutes INTEGER NOT NULL DEFAULT 5
    CHECK (acceptance_window_minutes >= 0),
  -- Clocks started through sdk-sla, by ref: this package does not own them.
  acceptance_clock_ref TEXT,
  response_clock_ref   TEXT,
  routing_decision_id  UUID,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A backup that is the primary is not a backup.
  CONSTRAINT assignment_record_backup_distinct CHECK (
    backup_persona_id IS NULL OR backup_persona_id <> primary_persona_id
  ),
  CONSTRAINT assignment_record_accepted_shape CHECK (
    state <> 'ACCEPTED' OR accepted_at IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS assignment_record_tenant_idx
  ON assignment.assignment_record (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assignment_record_subject_idx
  ON assignment.assignment_record (tenant_id, subject_ref);
-- The open-offer scan: which acceptance windows are running out.
CREATE INDEX IF NOT EXISTS assignment_record_open_idx
  ON assignment.assignment_record (tenant_id, offered_at)
  WHERE state = 'OFFERED';

CREATE OR REPLACE FUNCTION assignment.protect_assignment_provenance()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source_timestamp IS DISTINCT FROM OLD.source_timestamp THEN
    RAISE EXCEPTION
      'assignment_record %: source_timestamp is when the world produced this subject and never moves — a transfer changes the owner, not the clock',
      OLD.record_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.original_persona_id IS DISTINCT FROM OLD.original_persona_id THEN
    RAISE EXCEPTION
      'assignment_record %: original_persona_id records who owned this FIRST and cannot be rewritten to the current owner',
      OLD.record_id USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assignment_record_provenance_trg ON assignment.assignment_record;
CREATE TRIGGER assignment_record_provenance_trg
  BEFORE UPDATE ON assignment.assignment_record
  FOR EACH ROW EXECUTE FUNCTION assignment.protect_assignment_provenance();

/*
 * Every prior owner, and WHY they stopped being one.
 *
 * Append-only. A decline without a reason is a fact nobody can act on — "it bounced
 * three times" tells an operator nothing, while "wrong specialty, wrong specialty,
 * out of area" tells them the routing rules are wrong. So a reason is required by
 * CHECK for every transfer a person chose to make.
 */
CREATE TABLE IF NOT EXISTS assignment.assignment_history (
  history_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    UUID NOT NULL
    REFERENCES assignment.assignment_record (record_id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  from_persona_id UUID,
  to_persona_id   UUID,
  transition   assignment.assignment_state NOT NULL,
  reason       TEXT,
  actor        TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- A person's decision must say why; a system fallback explains itself by being one.
  CONSTRAINT assignment_history_reason_required CHECK (
    transition NOT IN ('DECLINED', 'REASSIGNED')
    OR (reason IS NOT NULL AND length(btrim(reason)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS assignment_history_seq_idx
  ON assignment.assignment_history (record_id, seq);
CREATE INDEX IF NOT EXISTS assignment_history_tenant_idx
  ON assignment.assignment_history (tenant_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION assignment.reject_history_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'assignment_history is append-only — entry % cannot be changed or removed',
    COALESCE(OLD.history_id, NEW.history_id) USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS assignment_history_append_only_trg ON assignment.assignment_history;
CREATE TRIGGER assignment_history_append_only_trg
  BEFORE UPDATE OR DELETE ON assignment.assignment_history
  FOR EACH ROW EXECUTE FUNCTION assignment.reject_history_mutation();
