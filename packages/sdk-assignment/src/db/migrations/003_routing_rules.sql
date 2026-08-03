-- Migration 003: versioned routing rules and the decision trace (P16 · EP-379 · PCF-06-1).
--
--   routing_rule_set   — the rules, as DATA and as VERSIONS
--   routing_decision   — what the pipeline decided, and why, step by step
--
-- WHY RULES ARE DATA. A routing rule changes when the business changes, which is
-- weekly; a deploy is not weekly. Rules that live in code mean every "send Texas to
-- the south team" waits on a release, so in practice they get hard-coded into one
-- vertical and the platform stops being one. Here a rule set is a row, a new version
-- is a new row, and activating one is an UPDATE.
--
-- WHY VERSIONS ARE IMMUTABLE. The trace on a decision names the rule VERSION that
-- produced it. If a version could be edited, last month's decision would explain
-- itself with this month's rules — which is worse than no explanation, because it is
-- a confident wrong one.
--
-- Idempotent + additive; rollback in ../down/003_routing_rules.down.sql.

CREATE TABLE IF NOT EXISTS assignment.routing_rule_set (
  rule_set_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  name         TEXT NOT NULL DEFAULT 'default',
  version      INTEGER NOT NULL CHECK (version > 0),
  /*
   * The six steps' configuration, one key per step:
   *   { "eligibility": [...], "priority_bands": [...], "specialty": {...},
   *     "availability": {...}, "assignment": {...}, "fallback": {...} }
   * JSONB rather than columns because the shape of a rule is the thing most likely
   * to change, and a migration per rule shape is the deploy this table exists to
   * avoid. The service validates the shape it reads.
   */
  rules        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active    BOOLEAN NOT NULL DEFAULT false,
  activated_at TIMESTAMPTZ,
  published_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS routing_rule_set_version_idx
  ON assignment.routing_rule_set (tenant_id, name, version);
-- One ACTIVE version per named set: two would make "which rules apply" a coin toss
-- at exactly the moment a routing decision needs one answer.
CREATE UNIQUE INDEX IF NOT EXISTS routing_rule_set_active_idx
  ON assignment.routing_rule_set (tenant_id, name)
  WHERE is_active;

/*
 * A published version is FROZEN. Only the activation flags may move — that is what
 * makes "which rules produced this decision" answerable months later.
 */
CREATE OR REPLACE FUNCTION assignment.reject_rule_set_edit()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'routing_rule_set % is referenced by past decisions and cannot be deleted; publish a new version',
      OLD.rule_set_id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.rules IS DISTINCT FROM OLD.rules
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION
      'routing_rule_set %(v%) is frozen — publish a new version instead of editing this one',
      OLD.name, OLD.version USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS routing_rule_set_frozen_trg ON assignment.routing_rule_set;
CREATE TRIGGER routing_rule_set_frozen_trg
  BEFORE UPDATE OR DELETE ON assignment.routing_rule_set
  FOR EACH ROW EXECUTE FUNCTION assignment.reject_rule_set_edit();

/*
 * The trace, persisted. An operator asking "why did this go there" is asking about a
 * decision that has already happened, so the explanation has to have been WRITTEN
 * DOWN at the time — re-running the pipeline today answers a different question,
 * because the rules, the roster and everybody's availability have all moved on.
 */
CREATE TABLE IF NOT EXISTS assignment.routing_decision (
  decision_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  -- Loose reference: what is being routed is the caller's business, not ours.
  subject_ref  TEXT NOT NULL,
  rule_set_id  UUID REFERENCES assignment.routing_rule_set (rule_set_id),
  rule_set_version INTEGER,
  outcome      TEXT NOT NULL CHECK (
    outcome IN ('ASSIGNED', 'FALLBACK', 'REVIEW', 'UNROUTABLE')
  ),
  chosen_persona_id UUID,
  -- One entry per step, in order, each with a plain-language sentence.
  steps        JSONB NOT NULL DEFAULT '[]'::jsonb,
  took_ms      INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A decision that chose nobody must not claim it assigned somebody.
  CONSTRAINT routing_decision_assigned_has_persona CHECK (
    outcome <> 'ASSIGNED' OR chosen_persona_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS routing_decision_tenant_idx
  ON assignment.routing_decision (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_decision_subject_idx
  ON assignment.routing_decision (tenant_id, subject_ref);
CREATE INDEX IF NOT EXISTS routing_decision_review_idx
  ON assignment.routing_decision (tenant_id, created_at DESC)
  WHERE outcome IN ('REVIEW', 'UNROUTABLE');
