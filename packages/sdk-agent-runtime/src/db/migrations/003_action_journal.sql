-- Migration 003: agents.action_journal for reversible-action journaling.
-- AC-8 / FR-ART-20: every state-changing agent action writes a compensable
-- journal entry. Rollback API (TK-3301) replays the journal in reverse,
-- calling each compensation step via sdk-workflow.
--
-- Forward-only; sha256-tracked. Cross-package FK to workflow.compensation
-- is intentionally a logical reference (UUID, no REFERENCES) — keeps the
-- packages independently deployable per the project's monorepo doctrine.

CREATE TABLE IF NOT EXISTS agents.action_journal (
  entry_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                UUID NOT NULL REFERENCES agents.agent_run(run_id) ON DELETE RESTRICT,
  step_seq              INTEGER NOT NULL,
  action_type           TEXT NOT NULL,
  /** Vault-wrapped args envelope. */
  args_envelope         BYTEA NOT NULL,
  /** Vault-wrapped undo payload (what to send to the compensation step). */
  undo_payload          BYTEA NOT NULL,
  /** Logical reference to workflow.compensation; no FK across pkg boundary. */
  compensation_step_id  UUID,
  /** Set when the rollback API has invoked the compensation step. */
  rolled_back_at        TIMESTAMPTZ,
  rolled_back_by        TEXT,
  recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT action_journal_step_seq_positive CHECK (step_seq >= 0),
  CONSTRAINT action_journal_run_step_uniq UNIQUE (run_id, step_seq),
  CONSTRAINT action_journal_rolled_back_attribution CHECK (
    rolled_back_at IS NULL OR rolled_back_by IS NOT NULL
  )
);

-- Replay-in-reverse hot path: rollback API reads journal entries for a run
-- ordered by step_seq DESC. The composite index is the natural fit.
CREATE INDEX IF NOT EXISTS action_journal_run_seq_idx
  ON agents.action_journal (run_id, step_seq DESC);

-- Operational lookup: which entries still need a rollback?
CREATE INDEX IF NOT EXISTS action_journal_pending_idx
  ON agents.action_journal (run_id, step_seq)
  WHERE rolled_back_at IS NULL;

-- Audit / observability: how many actions of a kind happened recently?
CREATE INDEX IF NOT EXISTS action_journal_action_type_idx
  ON agents.action_journal (action_type, recorded_at DESC);

COMMENT ON TABLE agents.action_journal
  IS 'AC-8 / FR-ART-20 · per-action journal supporting bounded-retention rollback via replay in reverse.';
COMMENT ON COLUMN agents.action_journal.compensation_step_id
  IS 'Logical reference to workflow.compensation row that the rollback API invokes when replaying this entry in reverse.';
COMMENT ON COLUMN agents.action_journal.undo_payload
  IS 'Vault-wrapped argument blob passed to the compensation step during rollback.';
