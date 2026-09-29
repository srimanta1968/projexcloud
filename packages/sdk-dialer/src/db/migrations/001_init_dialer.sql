-- Migration 001: sdk-dialer — outbound AI-call campaigns, contacts and the dispatch queue.
-- VA·E5 (TK-4478). Auto-applied via api-gateway runMigrations.
--
-- Not a copy of sdk-campaign: campaign.campaign is a MARKETING journey (segment DSL,
-- per-persona journey runs) with no phone numbers, attempts or pacing. A dialer campaign
-- is a call list worked by the dispatcher. When a dialer campaign is the phone leg of a
-- marketing campaign it points at it through marketing_campaign_id (soft link, no FK —
-- the two SDKs migrate independently).
--
-- Every row is tenant-scoped with FORCE RLS as defence in depth; services still filter
-- tenant_id explicitly (the runtime role bypasses RLS).
--
-- Idempotent (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS dialer;

-- A campaign: which agent calls whom, when, how hard, and how often it retries.
CREATE TABLE IF NOT EXISTS dialer.campaign (
  campaign_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL,
  agent_id              UUID NOT NULL,                 -- voice_agent.agent; must be outbound/both + published to start
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','running','paused','cancelled','completed')),
  marketing_campaign_id UUID,                          -- optional soft link to campaign.campaign
  default_timezone      TEXT NOT NULL DEFAULT 'UTC',   -- when a contact has no tz of its own
  window_start          TIME NOT NULL DEFAULT '08:00', -- recipient-local calling window
  window_end            TIME NOT NULL DEFAULT '21:00',
  max_concurrency       INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrency BETWEEN 1 AND 1000),
  max_attempts          INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  retry_spacing_minutes INTEGER[] NOT NULL DEFAULT '{60,240,1440}',
  voicemail_policy      TEXT NOT NULL DEFAULT 'hang_up'
                          CHECK (voicemail_policy IN ('hang_up','drop_tts','drop_recording')),
  voicemail_message     TEXT,                          -- TTS text, or a recording ref for drop_recording
  caller_id_pool        TEXT[] NOT NULL DEFAULT '{}',  -- E.164 numbers the tenant owns
  context               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by            TEXT,
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (window_start < window_end)
);
CREATE UNIQUE INDEX IF NOT EXISTS dialer_campaign_name_idx ON dialer.campaign (tenant_id, name);
CREATE INDEX IF NOT EXISTS dialer_campaign_status_idx ON dialer.campaign (tenant_id, status, created_at DESC);

-- One person to call. external_ref is the consumer's own id (lead/contact), which makes a
-- batch upload an idempotent upsert: re-sending a batch updates rather than duplicates.
CREATE TABLE IF NOT EXISTS dialer.campaign_contact (
  contact_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES dialer.campaign (campaign_id) ON DELETE CASCADE,
  tenant_id        UUID NOT NULL,
  external_ref     TEXT NOT NULL,
  phone_number     TEXT NOT NULL,
  subject_ref      TEXT,
  crm_encounter_id UUID,
  timezone         TEXT,                               -- IANA; null -> campaign default_timezone
  context          JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','queued','in_progress','deferred','done','failed','refused','cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at  TIMESTAMPTZ,
  last_outcome     TEXT,                               -- last disposition or refusal reason
  last_call_id     UUID,                               -- voice_agent.call
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, external_ref)
);
CREATE INDEX IF NOT EXISTS dialer_contact_due_idx ON dialer.campaign_contact (campaign_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS dialer_contact_tenant_idx ON dialer.campaign_contact (tenant_id, campaign_id);

-- The dispatch queue: one row per call attempt waiting for capacity. Single API calls and
-- campaign contacts share it, so both pass the same gate chain and fair-share scheduler.
-- A worker claims a row by setting state = 'dispatching' with a lease; an expired lease
-- makes the row claimable again (crash recovery without a separate reaper).
CREATE TABLE IF NOT EXISTS dialer.dispatch_queue (
  queue_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  call_id      UUID NOT NULL,                          -- voice_agent.call being placed
  campaign_id  UUID REFERENCES dialer.campaign (campaign_id) ON DELETE CASCADE,
  contact_id   UUID REFERENCES dialer.campaign_contact (contact_id) ON DELETE CASCADE,
  direction    TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
  priority     INTEGER NOT NULL DEFAULT 100,           -- lower runs first; inbound uses 0
  state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued','dispatching','dispatched','deferred','refused','cancelled')),
  not_before   TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until  TIMESTAMPTZ,
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_reason  TEXT,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (call_id)
);
CREATE INDEX IF NOT EXISTS dialer_queue_ready_idx ON dialer.dispatch_queue (state, not_before, priority);
CREATE INDEX IF NOT EXISTS dialer_queue_tenant_idx ON dialer.dispatch_queue (tenant_id, state);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['campaign', 'campaign_contact', 'dispatch_queue'] LOOP
    EXECUTE format('ALTER TABLE dialer.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE dialer.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON dialer.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON dialer.%I '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

COMMENT ON TABLE dialer.campaign         IS 'Outbound AI-call campaign: agent, calling window, pacing, retry and voicemail policy.';
COMMENT ON TABLE dialer.campaign_contact IS 'One person to call; upserted by (campaign_id, external_ref); tracks attempts and the next attempt time.';
COMMENT ON TABLE dialer.dispatch_queue   IS 'Call attempts waiting for capacity; shared by campaign contacts and single API calls.';
