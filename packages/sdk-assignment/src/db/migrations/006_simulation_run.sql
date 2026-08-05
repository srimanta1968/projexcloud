-- Migration 006: a simulation is EVIDENCE, so it has to survive being cited.
--
-- simulate() answered "what would have happened" and handed the answer back as a
-- transient JSON body. That is enough to look at and not enough to CITE: a routing
-- change gets proposed on the strength of a simulation, approved weeks later, and
-- questioned months after that — and by then the only durable identifier in the
-- report is candidate_version, which names the RULES, never the RUN. Two simulations
-- of the same version over different windows or different candidate pools are
-- different evidence with identical labels, and a reviewer re-opening the proposal
-- has no way to reach the numbers the decision was actually made on.
--
-- So the run is recorded, once, with the inputs that produced it beside the report.
-- The inputs matter as much as the output: "these rules over this window against
-- these candidates" is the claim; the report alone is an unfalsifiable summary.
--
-- THIS IS NOT THE SIDE EFFECT THE GUARANTEE IS ABOUT. simulate promises it changes
-- nothing about ROUTING — no assignment, no notification, no clock, no
-- routing_decision row — and the side_effects block still proves exactly that by
-- counting assignment.routing_decision before and after. Recording that somebody
-- asked a question is not an answer to it, and an append here moves nothing in the
-- rotation, the ledger or anybody's queue.
--
-- Idempotent + additive; rollback in ../down/006_simulation_run.down.sql.

CREATE TABLE IF NOT EXISTS assignment.simulation_run (
  simulation_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  /*
   * THE INPUTS, kept beside the output. A report whose question was thrown away
   * cannot be checked, only believed.
   */
  candidate_version INTEGER NOT NULL,
  rule_set_name     TEXT,
  -- The replay window as it was ASKED for. NULL means "the caller did not bound it",
  -- which is a different fact from a window that happened to start at the epoch.
  window_from       TIMESTAMPTZ,
  window_to         TIMESTAMPTZ,
  candidate_persona_ids UUID[] NOT NULL,
  skew_tolerance    NUMERIC NOT NULL,
  subjects_replayed INTEGER NOT NULL CHECK (subjects_replayed >= 0),
  -- The whole report, verbatim. Denormalised on purpose: a consumer citing this run
  -- needs the numbers AS THEY WERE, and re-deriving them later would replay against
  -- history and rules that have since moved — which is the failure this table exists
  -- to prevent, not a cheaper way to store it.
  report            JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list a reviewer opens: this tenant's runs, newest first.
CREATE INDEX IF NOT EXISTS simulation_run_tenant_idx
  ON assignment.simulation_run (tenant_id, created_at DESC);
-- "Show me every simulation of the version we shipped."
CREATE INDEX IF NOT EXISTS simulation_run_version_idx
  ON assignment.simulation_run (tenant_id, rule_set_name, candidate_version);

/*
 * Append-only, for the same reason assignment_history is: a cited simulation that can
 * be edited afterwards is worse than no citation, because the proposal still points at
 * it and the numbers now agree with whatever happened. DELETE is deliberately allowed
 * — retention and tenant offboarding outrank this, exactly as migration 005 settled
 * for assignment_history.
 */
CREATE OR REPLACE FUNCTION assignment.reject_simulation_run_edit()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'simulation_run %: a simulation is the evidence a routing change was approved on and cannot be rewritten — run a new one',
    OLD.simulation_id USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS simulation_run_immutable_trg ON assignment.simulation_run;
CREATE TRIGGER simulation_run_immutable_trg
  BEFORE UPDATE ON assignment.simulation_run
  FOR EACH ROW EXECUTE FUNCTION assignment.reject_simulation_run_edit();

COMMENT ON TABLE assignment.simulation_run IS
  'One recorded simulate() run: its inputs and the report they produced, immutable so a routing proposal can cite it months later.';
