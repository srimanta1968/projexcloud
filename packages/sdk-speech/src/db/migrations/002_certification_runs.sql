-- Migration 002: sdk-speech — certification runs. VA·E10 (TK-4519).
-- Auto-applied via api-gateway runMigrations.
--
-- A catalog entry becomes certified only by PASSING a certification run — never by an
-- operator edit. A run tests one provider/model with a key from the tenant key vault
-- (sdk-ai-gateway tenant credentials; ProjexCloud hosts no provider keys of its own):
--
--   scope platform  started by an operator with a key the operator's own tenant keeps in the
--                   vault; a pass certifies the entry for every tenant (catalog_entry).
--   scope tenant    started by a tenant with its own key; a pass certifies the entry for that
--                   tenant only (tenant_certification) — the per-tenant enablement of an
--                   uncertified pair.
--
-- llm runs play reference agent scenarios (tool-call accuracy, time to first token,
-- barge-in). stt and tts runs are audio loopbacks and need a REFERENCE key of the other
-- layer: stt is fed phone-band audio a reference TTS synthesised (word error rate, time to
-- final transcript); tts audio is scored for time to first audio, real-time factor and — via
-- a reference STT — intelligibility.
--
-- Idempotent; down in ../down/.

CREATE TABLE IF NOT EXISTS speech.certification_run (
  run_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id              UUID NOT NULL REFERENCES speech.catalog_entry (entry_id) ON DELETE CASCADE,
  scope                 TEXT NOT NULL CHECK (scope IN ('platform', 'tenant')),
  -- Whose vault holds the keys (the operator's tenant for a platform run).
  tenant_id             UUID NOT NULL,
  binding_id            UUID NOT NULL,
  reference_binding_id  UUID,
  reference_model       TEXT,
  reference_voice       TEXT,
  status                TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'error')),
  passed                BOOLEAN,
  metrics               JSONB NOT NULL DEFAULT '{}'::jsonb,
  thresholds            JSONB NOT NULL DEFAULT '{}'::jsonb,
  error                 TEXT,
  requested_by          TEXT,
  claimed_by            TEXT,
  lease_until           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at            TIMESTAMPTZ,
  finished_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS speech_cert_run_entry_idx ON speech.certification_run (entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS speech_cert_run_tenant_idx ON speech.certification_run (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS speech_cert_run_queue_idx ON speech.certification_run (created_at) WHERE status IN ('queued', 'running');

-- A tenant's own certification of an entry (scope tenant). Deleted when a later run fails.
CREATE TABLE IF NOT EXISTS speech.tenant_certification (
  tenant_id     UUID NOT NULL,
  entry_id      UUID NOT NULL REFERENCES speech.catalog_entry (entry_id) ON DELETE CASCADE,
  run_id        UUID NOT NULL REFERENCES speech.certification_run (run_id) ON DELETE CASCADE,
  metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
  certified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entry_id)
);

ALTER TABLE speech.certification_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE speech.certification_run FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON speech.certification_run;
CREATE POLICY tenant_isolation ON speech.certification_run
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE speech.tenant_certification ENABLE ROW LEVEL SECURITY;
ALTER TABLE speech.tenant_certification FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON speech.tenant_certification;
CREATE POLICY tenant_isolation ON speech.tenant_certification
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
