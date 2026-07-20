-- Migration 002: sdk-handoff — saga phase tracking. P15 · E2 (TK-3647).
-- Auto-applied at boot. Additive + idempotent.
--
-- Durable per-handoff record of each saga phase (kickoff/prework/promises/risks/
-- milestones) executed by the sdk-workflow saga, so progress + compensation are
-- observable. The saga itself is driven by sdk-workflow (no new engine); this table is
-- the handoff-side projection. Idempotent per (handoff_id, phase).

CREATE TABLE IF NOT EXISTS handoff.saga_step (
  saga_step_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  handoff_id    UUID NOT NULL REFERENCES handoff.handoff(handoff_id) ON DELETE CASCADE,
  phase         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'done'
                  CHECK (status IN ('done','compensated')),
  run_id        UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (handoff_id, phase)
);

CREATE INDEX IF NOT EXISTS handoff_saga_step_idx ON handoff.saga_step (tenant_id, handoff_id);

COMMENT ON TABLE handoff.saga_step IS 'Per-handoff saga phase projection (kickoff/prework/promises/risks/milestones). Driven by the sdk-workflow saga; compensation flips status to compensated.';
