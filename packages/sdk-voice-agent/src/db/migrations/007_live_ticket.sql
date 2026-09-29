-- Migration 007: sdk-voice-agent — live-transcript WebSocket tickets. VA·E2 (TK-4477).
-- Auto-applied via api-gateway runMigrations.
--
-- A browser cannot set an Authorization header on a WebSocket, and a JWT in the query
-- string would be written to proxy access logs. So an authenticated, authorized caller
-- first POSTs /api/voice-agent/calls/:call_id/live-ticket and opens the socket with the
-- returned ticket: single-use, 60-second TTL, bound to one call and one persona. Only a
-- sha256 of the ticket is stored, so a database read cannot replay one.
--
-- Idempotent (IF NOT EXISTS); down in ../down/.

CREATE TABLE IF NOT EXISTS voice_agent.live_ticket (
  ticket_hash  TEXT PRIMARY KEY,
  tenant_id    UUID NOT NULL,
  call_id      UUID NOT NULL REFERENCES voice_agent.call (call_id) ON DELETE CASCADE,
  persona_id   TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_live_ticket_expiry_idx ON voice_agent.live_ticket (expires_at);

ALTER TABLE voice_agent.live_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_agent.live_ticket FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON voice_agent.live_ticket;
CREATE POLICY tenant_isolation ON voice_agent.live_ticket
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

COMMENT ON TABLE voice_agent.live_ticket IS 'Single-use, short-lived tickets that open the live-transcript WebSocket for one call.';
