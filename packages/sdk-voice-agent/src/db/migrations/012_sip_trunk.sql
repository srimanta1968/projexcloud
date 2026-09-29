-- Migration 012: sdk-voice-agent — tenant SIP trunks. VA·E6 (TK-4499).
-- Auto-applied via api-gateway runMigrations.
--
-- A tenant's carrier trunk wired to the platform's LiveKit SIP service:
--   inbound   carrier trunk origination URI -> LiveKit SIP; a LiveKit inbound trunk for the
--             tenant's numbers and a dispatch rule that puts each call in its own room with
--             the voice-runtime agent.
--   outbound  a LiveKit outbound trunk to the carrier's termination domain, authenticated
--             with a SIP credential created on the tenant's carrier account.
-- The SIP password is handed to the carrier and to LiveKit at provisioning time and never
-- stored here; only the username is kept (to rotate or audit it).
--
-- Idempotent; down in ../down/.

CREATE TABLE IF NOT EXISTS voice_agent.sip_trunk (
  trunk_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL,
  carrier                    TEXT NOT NULL CHECK (carrier IN ('twilio','telnyx')),
  -- The tenant's telephony credential (ai_gateway.tenant_provider_credential, layer telephony).
  credential_binding_id      UUID NOT NULL,
  carrier_trunk_ref          TEXT,          -- Twilio TrunkSid / Telnyx connection id
  termination_uri            TEXT,          -- e.g. projex-abc123.pstn.twilio.com
  origination_uri            TEXT,          -- the LiveKit SIP URI the carrier sends calls to
  credential_list_ref        TEXT,          -- carrier credential list holding the SIP user
  sip_username               TEXT,
  livekit_inbound_trunk_id   TEXT,
  livekit_outbound_trunk_id  TEXT,
  livekit_dispatch_rule_id   TEXT,
  numbers                    TEXT[] NOT NULL DEFAULT '{}',
  status                     TEXT NOT NULL DEFAULT 'provisioning'
                               CHECK (status IN ('provisioning','active','error','deleted')),
  last_error                 TEXT,
  created_by                 TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live trunk per tenant and carrier.
CREATE UNIQUE INDEX IF NOT EXISTS sip_trunk_live_uniq
  ON voice_agent.sip_trunk (tenant_id, carrier) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS sip_trunk_tenant_idx ON voice_agent.sip_trunk (tenant_id, created_at DESC);

ALTER TABLE voice_agent.sip_trunk ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sip_trunk_tenant_isolation ON voice_agent.sip_trunk;
CREATE POLICY sip_trunk_tenant_isolation ON voice_agent.sip_trunk
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

COMMENT ON TABLE voice_agent.sip_trunk IS 'Tenant carrier SIP trunk wired to LiveKit SIP (inbound trunk + dispatch rule, outbound trunk). The SIP password is never stored.';
