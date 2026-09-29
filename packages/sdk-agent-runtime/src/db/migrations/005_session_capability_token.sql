-- Migration 005: session-scoped capability tokens (VA·E7 · TK-4508).
-- Auto-applied by the migration runner at boot. ADDITIVE + idempotent.
--
-- agents.capability_token (001) is per TOOL INVOCATION: single-use, bound to one tool and
-- one argument hash, at most 300 s, and tied by FK to an agents.agent_run. A live voice call
-- cannot work that way — the agent calls several tools, any number of times, in real time,
-- and a mint round-trip before every tool call would sit in the audio path.
--
-- A session token is minted ONCE per session (one AI call) and authorizes exactly that
-- session's allowed tool list, for the session's lifetime:
--
--   tier             the session class; its maximum TTL is enforced here AND in the service
--                    (voice: 2 h — longer than any sane call, short enough that a leaked
--                    token dies on its own)
--   session_ref      what the token belongs to, e.g. 'voice_agent.call:<call_id>'. At most
--                    one LIVE token per (tier, session_ref): minting again returns it.
--   agent_ref /      the agent and the exact version whose tool list was granted; there is
--   agent_version_ref no FK because a voice agent is not an agents.agent_definition row
--   allowed_tools    tool names the token authorizes — nothing else validates
--   secret_digest    SHA-256(secret || bound fields). The 32-byte secret is handed out once
--                    and never stored; the digest proves both that the caller holds it and
--                    that no bound field (tools, tenant, session, times) was edited. No
--                    signing key is involved, so a key rotation cannot void a live call's token.
--
-- Revoked when the session ends (the call completes), or explicitly.

CREATE TABLE IF NOT EXISTS agents.session_capability_token (
  token_id           UUID PRIMARY KEY,
  tier               TEXT NOT NULL CHECK (tier IN ('voice')),
  tenant_id          UUID NOT NULL,
  session_ref        TEXT NOT NULL CHECK (length(session_ref) BETWEEN 1 AND 200),
  agent_ref          TEXT NOT NULL,
  agent_version_ref  TEXT,
  acting_persona_id  UUID,
  allowed_tools      TEXT[] NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  use_count          INTEGER NOT NULL DEFAULT 0,
  last_used_at       TIMESTAMPTZ,
  last_used_tool     TEXT,
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,
  secret_digest      BYTEA NOT NULL CHECK (length(secret_digest) = 32),

  CONSTRAINT session_token_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT session_token_voice_ttl CHECK (tier <> 'voice' OR expires_at <= issued_at + interval '2 hours'),
  CONSTRAINT session_token_revoked_reason CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL)
);

-- One live token per session. Revoked tokens drop out of the index, so a session that is
-- revoked (e.g. a kill) and legitimately re-minted does not collide with its history.
CREATE UNIQUE INDEX IF NOT EXISTS session_token_live_uidx
  ON agents.session_capability_token (tier, session_ref) WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS session_token_tenant_idx
  ON agents.session_capability_token (tenant_id, issued_at DESC);

COMMENT ON TABLE agents.session_capability_token IS
  'Session-scoped capability tokens (TK-4508): one per session (e.g. AI call), authorizing its allowed tool list until expiry or revocation. Multi-use by design; per-invocation tokens stay in agents.capability_token.';
