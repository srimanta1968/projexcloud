-- Migration 001: sdk-voice-agent — control plane for BYOK voice agents. VA·E2 (TK-4468).
-- Auto-applied via api-gateway runMigrations.
--
-- One schema owns everything the voice runtime reads once per call and writes once
-- per call: stack profiles cloned from presets, agents and their immutable versions,
-- inbound number bindings, app-registered tools, AI call records and turn transcripts.
-- Provider keys are NOT stored here — stack_profile.credential_refs holds sdk-secrets /
-- ai-gateway tenant-credential references only.
--
-- Tenant isolation: every table carries tenant_id and has a FORCE'd RLS policy on
-- app.tenant_id (defense in depth — services still filter tenant_id explicitly, as the
-- gateway's DB role bypasses RLS). The one lookup that runs before a tenant is known,
-- inbound DID -> agent, goes through voice_agent.resolve_number(), a SECURITY DEFINER
-- function that returns only routing columns.
--
-- Cross-SDK references (persona, approval, eval run, kb corpus, credential) are loose
-- UUIDs, matching the P14/P15 convention. Idempotent (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS voice_agent;

-- ---------------------------------------------------------------- stack_profile
-- A tenant's concrete provider stack, cloned from a system preset (budget | balanced |
-- premium | realtime | private) and then overridden per layer. Each layer column is
-- {provider, model, voice?, options?}; credential_refs maps layer -> {primary, secondary}.
CREATE TABLE IF NOT EXISTS voice_agent.stack_profile (
  profile_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  name             TEXT NOT NULL,
  preset_key       TEXT NOT NULL
                     CHECK (preset_key IN ('budget','balanced','premium','realtime','private')),
  telephony        JSONB NOT NULL DEFAULT '{}'::jsonb,
  stt              JSONB NOT NULL DEFAULT '{}'::jsonb,
  llm_fast         JSONB NOT NULL DEFAULT '{}'::jsonb,
  llm_complex      JSONB NOT NULL DEFAULT '{}'::jsonb,
  tts              JSONB NOT NULL DEFAULT '{}'::jsonb,
  realtime         JSONB,
  credential_refs  JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallbacks        JSONB NOT NULL DEFAULT '{}'::jsonb,
  certified        BOOLEAN NOT NULL DEFAULT false,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS voice_stack_profile_tenant_idx ON voice_agent.stack_profile (tenant_id, status);

-- ------------------------------------------------------------------------ agent
-- The stable identity of a voice agent. What it says and does lives in agent_version;
-- published_version_id is the one live version (NULL until first publish).
CREATE TABLE IF NOT EXISTS voice_agent.agent (
  agent_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  -- The consumer app that owns this agent (LeadFlow, projex_crm, …) — loose ref.
  app_id               UUID,
  name                 TEXT NOT NULL,
  direction            TEXT NOT NULL DEFAULT 'inbound'
                         CHECK (direction IN ('inbound','outbound','both')),
  acting_persona_id    UUID,
  published_version_id UUID,
  kill_switch_flag_id  UUID,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','published','paused','archived')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS voice_agent_tenant_idx ON voice_agent.agent (tenant_id, status);

-- ---------------------------------------------------------------- agent_version
-- Immutable once created: a change is a new version_no. Publish needs a passing
-- evaluation run and an sdk-approval approval (both loose refs, set at publish time).
CREATE TABLE IF NOT EXISTS voice_agent.agent_version (
  version_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          UUID NOT NULL REFERENCES voice_agent.agent (agent_id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL,
  version_no        INTEGER NOT NULL CHECK (version_no > 0),
  system_prompt     TEXT NOT NULL,
  greeting          TEXT,
  language          TEXT NOT NULL DEFAULT 'en-US',
  stack_profile_id  UUID NOT NULL REFERENCES voice_agent.stack_profile (profile_id),
  tool_ids          UUID[] NOT NULL DEFAULT '{}',
  kb_corpus_ids     UUID[] NOT NULL DEFAULT '{}',
  escalation_rules  JSONB NOT NULL DEFAULT '{}'::jsonb,
  business_hours    JSONB NOT NULL DEFAULT '{}'::jsonb,
  eval_run_id       UUID,
  approval_id       UUID,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version_no)
);
CREATE INDEX IF NOT EXISTS voice_agent_version_tenant_idx ON voice_agent.agent_version (tenant_id, agent_id);

-- --------------------------------------------------------------- number_binding
-- Which agent answers an inbound E.164 number. A number can route to only ONE active
-- binding platform-wide (a carrier delivers a DID to exactly one place), which is why
-- the active-number index is NOT tenant-scoped.
CREATE TABLE IF NOT EXISTS voice_agent.number_binding (
  binding_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL,
  carrier       TEXT NOT NULL CHECK (carrier IN ('twilio','telnyx','sip')),
  phone_number  TEXT NOT NULL CHECK (phone_number ~ '^\+[1-9][0-9]{6,14}$'),
  agent_id      UUID NOT NULL REFERENCES voice_agent.agent (agent_id) ON DELETE CASCADE,
  fallback      TEXT NOT NULL DEFAULT 'voicemail'
                  CHECK (fallback IN ('voicemail','forward','ivr')),
  fallback_target TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS voice_number_active_idx
  ON voice_agent.number_binding (phone_number) WHERE active;
CREATE INDEX IF NOT EXISTS voice_number_tenant_idx ON voice_agent.number_binding (tenant_id, agent_id);

-- --------------------------------------------------------------------- app_tool
-- An HTTPS endpoint a consumer app registers so its business logic can run mid-call.
-- The signing secret is a reference only; the runtime resolves it via sdk-secrets.
CREATE TABLE IF NOT EXISTS voice_agent.app_tool (
  tool_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL,
  app_id              UUID,
  name                TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9_]{1,63}$'),
  description         TEXT,
  json_schema         JSONB NOT NULL,
  url                 TEXT NOT NULL CHECK (url ~ '^https://'),
  signing_secret_ref  TEXT NOT NULL,
  timeout_ms          INTEGER NOT NULL DEFAULT 1500 CHECK (timeout_ms BETWEEN 100 AND 10000),
  idempotent          BOOLEAN NOT NULL DEFAULT false,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- COALESCE: a NULL app_id must still collide with another NULL-app tool of the same name.
CREATE UNIQUE INDEX IF NOT EXISTS voice_app_tool_name_idx
  ON voice_agent.app_tool (tenant_id, COALESCE(app_id, '00000000-0000-0000-0000-000000000000'::uuid), name);

-- ------------------------------------------------------------------------- call
-- One AI call, inbound or outbound. idempotency_key makes a retried outbound request
-- place the call once; gate_verdicts records every compliance decision so a refusal is
-- auditable after the fact; cost_breakdown is the tenant's provider spend (display only).
CREATE TABLE IF NOT EXISTS voice_agent.call (
  call_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  agent_id          UUID NOT NULL REFERENCES voice_agent.agent (agent_id),
  agent_version_id  UUID REFERENCES voice_agent.agent_version (version_id),
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  subject_ref       TEXT,
  from_number       TEXT,
  to_number         TEXT,
  carrier_call_ref  TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','deferred','refused','dialing','ringing',
                                        'in_progress','transferred','completed','failed')),
  answered_by       TEXT CHECK (answered_by IN ('human','machine','unknown')),
  disposition       TEXT CHECK (disposition IN (
                      'connected_qualified','connected_not_interested','callback_requested',
                      'meeting_booked','voicemail','no_answer','busy','wrong_number','opt_out','failed')),
  summary           TEXT,
  context           JSONB NOT NULL DEFAULT '{}'::jsonb,
  gate_verdicts     JSONB NOT NULL DEFAULT '{}'::jsonb,
  recording_consent BOOLEAN,
  recording_ref     TEXT,
  cost_breakdown    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test           BOOLEAN NOT NULL DEFAULT false,
  idempotency_key   TEXT,
  next_attempt_at   TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  answered_at       TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  duration_s        INTEGER CHECK (duration_s >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS voice_call_tenant_idx  ON voice_agent.call (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_agent_idx   ON voice_agent.call (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS voice_call_subject_idx ON voice_agent.call (tenant_id, subject_ref) WHERE subject_ref IS NOT NULL;

-- -------------------------------------------------------------------- call_turn
-- Turn-level transcript, batch-inserted once at call end (per-turn metrics also stream
-- to ClickHouse). Latency columns are milliseconds for that turn's stages.
CREATE TABLE IF NOT EXISTS voice_agent.call_turn (
  call_id      UUID NOT NULL REFERENCES voice_agent.call (call_id) ON DELETE CASCADE,
  turn_index   INTEGER NOT NULL CHECK (turn_index >= 0),
  tenant_id    UUID NOT NULL,
  speaker      TEXT NOT NULL CHECK (speaker IN ('caller','agent','system')),
  text         TEXT NOT NULL,
  started_ms   INTEGER,
  stt_ms       INTEGER,
  ttft_ms      INTEGER,
  ttfa_ms      INTEGER,
  interrupted  BOOLEAN NOT NULL DEFAULT false,
  tool_calls   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (call_id, turn_index)
);
CREATE INDEX IF NOT EXISTS voice_call_turn_tenant_idx ON voice_agent.call_turn (tenant_id, call_id);

-- -------------------------------------------------------------------------- RLS
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['stack_profile','agent','agent_version','number_binding','app_tool','call','call_turn']
  LOOP
    EXECUTE format('ALTER TABLE voice_agent.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE voice_agent.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON voice_agent.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON voice_agent.%I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

-- ------------------------------------------------------ inbound number resolution
-- Runs before any tenant is known (an inbound INVITE carries only the dialled DID), so
-- it cannot go through the tenant policy. SECURITY DEFINER with a pinned search_path,
-- returning routing columns only — never prompts, keys or call data.
CREATE OR REPLACE FUNCTION voice_agent.resolve_number(p_phone_number TEXT)
RETURNS TABLE (tenant_id UUID, agent_id UUID, binding_id UUID, carrier TEXT, fallback TEXT, fallback_target TEXT)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = voice_agent, pg_temp
AS $fn$
  SELECT b.tenant_id, b.agent_id, b.binding_id, b.carrier, b.fallback, b.fallback_target
    FROM voice_agent.number_binding b
   WHERE b.phone_number = p_phone_number AND b.active
   LIMIT 1
$fn$;

COMMENT ON SCHEMA voice_agent IS 'sdk-voice-agent · VA·E2 control plane for multi-tenant BYOK voice agents.';
COMMENT ON TABLE  voice_agent.stack_profile IS 'Tenant provider stack cloned from a preset; credential_refs holds references only, never keys.';
COMMENT ON TABLE  voice_agent.agent_version IS 'Immutable agent configuration; publish requires eval_run_id + approval_id.';
COMMENT ON TABLE  voice_agent.number_binding IS 'Inbound E.164 -> agent routing. One active binding per number platform-wide.';
COMMENT ON TABLE  voice_agent.call IS 'One AI call. UNIQUE(tenant_id, idempotency_key) places a retried request once; gate_verdicts audits every compliance decision.';
COMMENT ON FUNCTION voice_agent.resolve_number(TEXT) IS 'Pre-tenant DID lookup for the voice runtime; returns routing columns only.';
