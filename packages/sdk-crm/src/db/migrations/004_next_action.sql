-- Migration 004: sdk-crm — mandatory NEXT-action model + save-gate.
-- P14 · E4 (TK-3630). Auto-applied at boot. Additive + idempotent.
--
-- Every non-terminal deal MUST carry exactly ONE open NEXT action (what happens next,
-- who owns it, when it's due, why). The save-gate blocks a save / stage-advance on a
-- non-terminal deal that has no open next action. Terminal deals (closed-won/lost, or an
-- is_terminal funnel stage) are exempt.

CREATE TABLE IF NOT EXISTS crm.next_action (
  next_action_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  deal_id         UUID NOT NULL REFERENCES crm.deal(deal_id) ON DELETE CASCADE,
  action_type     TEXT NOT NULL DEFAULT 'call'
                    CHECK (action_type IN ('call','email','meeting','task','linkedin','sms','proposal','other')),
  owner_persona_id UUID,
  due_at          TIMESTAMPTZ NOT NULL,
  purpose         TEXT,
  outcome         TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','completed','cancelled')),
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most ONE open next action per deal (the single "what's next" the rep must own).
CREATE UNIQUE INDEX IF NOT EXISTS crm_next_action_open_idx
  ON crm.next_action (deal_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS crm_next_action_owner_idx
  ON crm.next_action (tenant_id, owner_persona_id, due_at) WHERE status = 'open';

COMMENT ON TABLE crm.next_action IS 'Mandatory single open NEXT action per non-terminal deal (type/owner/due/purpose). Save-gate blocks save/advance when missing.';
