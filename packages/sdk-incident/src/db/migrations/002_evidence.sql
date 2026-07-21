-- Migration 002: sdk-incident — evidence timeline. P15 · E3 (TK-3651).
-- Auto-applied by the migration runner at boot.
--
-- One row per timeline event on an incident (detected / root_cause / recovery /
-- verification / note). Each row is ALSO appended to the sdk-audit hash-chained
-- ledger, and the resulting entry id + seq + entry_hash are stored here as the
-- immutability receipt: the audit chain is the tamper-evident record, this table
-- is the queryable projection of it.
--
-- APPEND-ONLY: enforced in the database, not merely by convention — a trigger
-- rejects every UPDATE and DELETE on incident.evidence, so evidence cannot be
-- rewritten or erased even by code that bypasses the service layer.
--
-- Idempotent + re-runnable (IF NOT EXISTS); down in ../down/.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS incident;

CREATE TABLE IF NOT EXISTS incident.evidence (
  evidence_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL,
  -- RESTRICT, not CASCADE: the append-only trigger below blocks the DELETE a
  -- cascade would issue, so a CASCADE here would only ever surface as an opaque
  -- trigger error. RESTRICT states the real rule declaratively — evidence pins
  -- its incident, and an incident that has been written about cannot be erased.
  incident_id            UUID NOT NULL
                           REFERENCES incident.incident (incident_id) ON DELETE RESTRICT,
  kind                   TEXT NOT NULL
                           CHECK (kind IN ('detected','root_cause','recovery','verification','note')),
  body                   TEXT NOT NULL,
  evidence_ref           TEXT,
  recorded_by_persona_id UUID,
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- sdk-audit immutability receipt (null only if the audit emit was unavailable).
  audit_entry_id         UUID,
  audit_seq              BIGINT,
  audit_entry_hash       TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-heal: an environment that applied an earlier cut of this migration has the
-- FK as ON DELETE CASCADE. Re-point it at RESTRICT (idempotent — re-running when
-- it is already RESTRICT is a no-op).
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
   WHERE ns.nspname = 'incident' AND rel.relname = 'evidence'
     AND con.contype = 'f' AND con.confdeltype = 'c';   -- 'c' = CASCADE
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE incident.evidence DROP CONSTRAINT %I', fk_name);
    ALTER TABLE incident.evidence
      ADD CONSTRAINT evidence_incident_id_fkey
      FOREIGN KEY (incident_id) REFERENCES incident.incident (incident_id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Timeline read path: every entry for one incident in chronological order.
CREATE INDEX IF NOT EXISTS incident_evidence_timeline_idx
  ON incident.evidence (incident_id, occurred_at, created_at);
CREATE INDEX IF NOT EXISTS incident_evidence_tenant_idx
  ON incident.evidence (tenant_id, kind);

-- Append-only guard: block UPDATE/DELETE at the table level.
CREATE OR REPLACE FUNCTION incident.evidence_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '[sdk-incident] incident.evidence is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incident_evidence_append_only ON incident.evidence;
CREATE TRIGGER incident_evidence_append_only
  BEFORE UPDATE OR DELETE ON incident.evidence
  FOR EACH ROW EXECUTE FUNCTION incident.evidence_append_only();

COMMENT ON TABLE  incident.evidence IS 'Append-only incident evidence timeline (detected/root_cause/recovery/verification/note); mirrored into the sdk-audit hash chain. UPDATE/DELETE blocked by trigger.';
COMMENT ON COLUMN incident.evidence.audit_entry_id   IS 'sdk-audit ledger entry id for this evidence entry (immutability receipt).';
COMMENT ON COLUMN incident.evidence.audit_entry_hash IS 'Hex entry_hash of the sdk-audit chain entry — proves the evidence text was not altered after recording.';
