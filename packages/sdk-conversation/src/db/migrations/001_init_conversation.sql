-- Migration 001: sdk-conversation canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §6.

CREATE SCHEMA IF NOT EXISTS conversation;

-- ---------------------------------------------------------------------------
-- conversation.session — one row per chat session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation.session (
  session_id          TEXT PRIMARY KEY,
  tenant_id           UUID NOT NULL,
  subject_persona_id  UUID NOT NULL,
  agent_id            UUID,
  status              TEXT NOT NULL DEFAULT 'started'
                        CHECK (status IN ('started','active','handed-off','closed')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at           TIMESTAMPTZ,
  -- HARD-isolated per-session namespace; reuses P6A FR-ART-13.
  vector_namespace    TEXT NOT NULL,

  CONSTRAINT conv_session_closed_after CHECK (closed_at IS NULL OR closed_at >= started_at)
);

CREATE INDEX IF NOT EXISTS conv_session_tenant_idx  ON conversation.session (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conv_session_persona_idx ON conversation.session (subject_persona_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conv_session_status_idx  ON conversation.session (status, last_active_at DESC);

-- ---------------------------------------------------------------------------
-- conversation.turn — per-message storage.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation.turn (
  turn_id              TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES conversation.session(session_id) ON DELETE CASCADE,
  seq                  INTEGER NOT NULL CHECK (seq >= 0),
  author_kind          TEXT NOT NULL
                         CHECK (author_kind IN ('user','agent','human-agent','system')),
  author_id            UUID NOT NULL,
  -- Vault-wrapped message body; plaintext never lives on disk.
  message_envelope     BYTEA NOT NULL,
  tokens               INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  model_used           TEXT,
  -- Cross-link into sdk-knowledge-rag grounding.
  rag_retrieval_id     TEXT,
  occurred_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT conv_turn_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS conv_turn_session_idx ON conversation.turn (session_id, seq);
CREATE INDEX IF NOT EXISTS conv_turn_rag_idx     ON conversation.turn (rag_retrieval_id) WHERE rag_retrieval_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- conversation.handoff — AI ↔ human transitions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversation.handoff (
  handoff_id      TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES conversation.session(session_id) ON DELETE CASCADE,
  from_kind       TEXT NOT NULL CHECK (from_kind IN ('ai','human')),
  to_persona_id   UUID NOT NULL,
  reason          TEXT NOT NULL,
  transferred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at      TIMESTAMPTZ,

  CONSTRAINT conv_handoff_resumed_after CHECK (resumed_at IS NULL OR resumed_at >= transferred_at)
);

CREATE INDEX IF NOT EXISTS conv_handoff_session_idx  ON conversation.handoff (session_id, transferred_at);
CREATE INDEX IF NOT EXISTS conv_handoff_assignee_idx ON conversation.handoff (to_persona_id) WHERE resumed_at IS NULL;

COMMENT ON SCHEMA conversation IS 'sdk-conversation (P6B §5.3). Chat sessions, turn storage, AI↔human handoff.';
