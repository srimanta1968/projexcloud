-- Migration 001: sdk-source-record — the provenance kernel (P16 · EP-374 / PCF-01-1).
--
-- Four tables and four Postgres ENUM types behind link-over-merge semantics: a
-- source assertion is NEVER destroyed. Conflicting values from different origins
-- coexist by design; the *display* value is resolved downstream by sdk-projection,
-- not here.
--
--   source_record            — one immutable capture from one source system
--   source_assertion         — bitemporal attribute claims about a subject
--   source_rights_attestation— signed rights/permitted-use record over a capture
--   id_crosswalk             — external system + id, preserved forever
--
-- IMMUTABILITY IS ENFORCED IN THE DATABASE, not by convention. Triggers reject:
--   * any UPDATE that changes source_record.raw_evidence or .origin_class
--   * any UPDATE of an assertion's value/attribute/origin_class/effective dates
--     (only the supersede columns and status may move — that is how link-over-merge
--     stays honest), and any DELETE of an assertion
--   * any UPDATE or DELETE of a signed attestation
--   * any UPDATE of a crosswalk's external_system/external_id, and any DELETE
--
-- Cross-SDK references (subject_ref, evidence_ref, attestor_principal) are LOOSE
-- text/uuid — no hard FKs into other SDK schemas, so this migration is
-- self-contained and order-independent (same rule as sdk-sequence/sdk-scheduling).
--
-- Idempotent + re-runnable: every object uses IF NOT EXISTS / duplicate-object
-- guards, so it is safe on every boot. Rollback companion:
-- ../down/001_init_source_record.down.sql (not auto-applied — forward-only).

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS source_record;

-- ============================================================ ENUM TYPES
-- Real Postgres ENUMs (not CHECK constraints): the trust ladder and the origin
-- taxonomy are a closed platform vocabulary, and an ENUM makes an unknown value a
-- write-time error in every consumer, including psql and BI tools.

-- origin_class — WHERE the data came from. There is deliberately no "default" for
-- unrecognised input: absent/unknown provenance routes to UNKNOWN_QUARANTINED so a
-- record can never silently acquire trust it did not earn.
DO $$ BEGIN
  CREATE TYPE source_record.origin_class AS ENUM (
    'USER_PROVIDED',
    'FIRST_PARTY_DIRECT',
    'TENANT_FIRST_PARTY_CRM',
    'USER_AUTHORIZED_CONTACT_STORE',
    'PUBLIC_RECORD',
    'LICENSED_THIRD_PARTY',
    'PARTNER_PROVIDED',
    'UNKNOWN_QUARANTINED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- trust_state — the progressive trust ladder. P0 captured -> P1 normalized ->
-- P2 candidate -> P3 linked -> P4 direct. Promotion is one rung at a time and
-- carries per-transition evidence requirements (enforced in the service layer).
DO $$ BEGIN
  CREATE TYPE source_record.trust_state AS ENUM (
    'P0_CAPTURED',
    'P1_NORMALIZED',
    'P2_CANDIDATE',
    'P3_LINKED',
    'P4_DIRECT'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- assertion_status — ASSERTION is the neutral landed state; SURVIVES marks the
-- projection winner; PRIMARY marks an operator-pinned claim; SUPERSEDED marks a
-- claim replaced by a newer one (the row itself always stays).
DO $$ BEGIN
  CREATE TYPE source_record.assertion_status AS ENUM (
    'SURVIVES',
    'ASSERTION',
    'SUPERSEDED',
    'PRIMARY'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- evidence_kind — what the evidence blob behind a capture/attestation actually is.
DO $$ BEGIN
  CREATE TYPE source_record.evidence_kind AS ENUM (
    'RAW_PAYLOAD',
    'API_RESPONSE',
    'DOCUMENT',
    'SCREENSHOT',
    'LICENSE_TERMS',
    'CONSENT_RECEIPT',
    'SIGNATURE',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ================================================ source_record.source_record
-- One capture = one retrieval of one payload from one source system. raw_evidence
-- is the payload exactly as received; it is immutable so the chain of custody
-- survives every later normalization.
--
-- fingerprint is the caller-supplied content hash of the capture. UNIQUE per tenant
-- gives capture idempotency: a retried ingest returns the existing capture instead
-- of forking a duplicate lineage.
CREATE TABLE IF NOT EXISTS source_record.source_record (
  capture_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  source_system      TEXT NOT NULL,
  source_external_id TEXT,
  -- Immutable after insert (enforced by trigger below).
  raw_evidence       JSONB NOT NULL,
  fingerprint        TEXT NOT NULL,
  retrieved_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Immutable after insert (enforced by trigger below). No DEFAULT: the caller must
  -- classify, and the service quarantines anything it cannot classify.
  origin_class       source_record.origin_class NOT NULL,
  trust_state        source_record.trust_state NOT NULL DEFAULT 'P0_CAPTURED',
  evidence_kind      source_record.evidence_kind NOT NULL DEFAULT 'RAW_PAYLOAD',
  -- Loose ref into sdk-evidence (blob id) — no cross-schema FK.
  evidence_ref       TEXT,
  -- Loose ref to whatever entity the capture is about (persona/place/org). Set once
  -- the record is linked (P3+); NULL while it is still a free-floating capture.
  subject_ref        TEXT,
  normalized         JSONB,
  quarantine_reason  TEXT,
  promoted_at        TIMESTAMPTZ,
  normalized_at      TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Fingerprint dedupe: the same payload from the same tenant is ONE capture.
  UNIQUE (tenant_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS source_record_tenant_trust_idx
  ON source_record.source_record (tenant_id, trust_state);
CREATE INDEX IF NOT EXISTS source_record_tenant_origin_idx
  ON source_record.source_record (tenant_id, origin_class);
CREATE INDEX IF NOT EXISTS source_record_subject_idx
  ON source_record.source_record (tenant_id, subject_ref)
  WHERE subject_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_record_system_external_idx
  ON source_record.source_record (tenant_id, source_system, source_external_id);

-- ============================================= source_record.source_assertion
-- A bitemporal claim: "at effective_from..effective_to, this subject's <attribute>
-- was <value>, per <origin_class>, retrieved at <retrieved_at>".
--
-- Two time axes, deliberately separate:
--   effective_from/effective_to — when the fact was TRUE in the world
--   retrieved_at                — when WE learned it
--
-- Superseding sets status + superseded_by on the prior row. The value column is
-- never rewritten and the row is never deleted (trigger-enforced), so a conflicting
-- pair of assertions from different origins stays fully queryable forever.
CREATE TABLE IF NOT EXISTS source_record.source_assertion (
  assertion_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  -- RESTRICT, not CASCADE: a cascading delete would try to DELETE assertions and
  -- trip the append-only trigger with an opaque error. Blocking it declaratively at
  -- the FK is the honest rule.
  capture_id      UUID REFERENCES source_record.source_record (capture_id) ON DELETE RESTRICT,
  subject_ref     TEXT NOT NULL,
  attribute       TEXT NOT NULL,
  -- May hold ciphertext when the attribute carries PII; value_encrypted says which,
  -- and vault_key_ref points at the sdk-vault envelope used.
  value           TEXT,
  value_encrypted BOOLEAN NOT NULL DEFAULT false,
  vault_key_ref   TEXT,
  origin_class    source_record.origin_class NOT NULL,
  confidence      NUMERIC(5, 4) NOT NULL DEFAULT 1.0
                    CHECK (confidence >= 0 AND confidence <= 1),
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to    TIMESTAMPTZ,
  retrieved_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          source_record.assertion_status NOT NULL DEFAULT 'ASSERTION',
  evidence_ref    TEXT,
  superseded_by   UUID REFERENCES source_record.source_assertion (assertion_id) ON DELETE RESTRICT,
  superseded_at   TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- A superseded row must name its successor, and only a superseded row may.
  CHECK (
    (status = 'SUPERSEDED' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL)
    OR (status <> 'SUPERSEDED' AND superseded_by IS NULL AND superseded_at IS NULL)
  ),
  -- An assertion cannot supersede itself.
  CHECK (superseded_by IS NULL OR superseded_by <> assertion_id)
);

-- The survivorship read path: every coexisting claim for one subject+attribute.
CREATE INDEX IF NOT EXISTS source_assertion_subject_attribute_idx
  ON source_record.source_assertion (subject_ref, attribute);
CREATE INDEX IF NOT EXISTS source_assertion_tenant_origin_idx
  ON source_record.source_assertion (tenant_id, origin_class);
CREATE INDEX IF NOT EXISTS source_assertion_tenant_status_idx
  ON source_record.source_assertion (tenant_id, status);
CREATE INDEX IF NOT EXISTS source_assertion_capture_idx
  ON source_record.source_assertion (capture_id);

-- ==================================== source_record.source_rights_attestation
-- The signed answer to "were we allowed to have this, and what may we do with it?".
-- permitted_uses is the closed set a downstream consumer is checked against; a
-- purpose outside it is refused (checkPermittedUse in the service layer).
--
-- Immutable once written: an attestation whose terms could be edited after signing
-- would be worthless as evidence.
CREATE TABLE IF NOT EXISTS source_record.source_rights_attestation (
  attestation_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  capture_id           UUID REFERENCES source_record.source_record (capture_id) ON DELETE RESTRICT,
  -- The capture fingerprint the signature covers, denormalized so the attestation
  -- verifies standalone even if the capture row is archived out of the hot table.
  source_fingerprint   TEXT NOT NULL,
  -- Platform principal of the signer (loose ref into sdk-identity).
  attestor_principal   TEXT NOT NULL,
  origin_class         source_record.origin_class NOT NULL,
  permitted_uses       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  jurisdiction         TEXT,
  license_ref          TEXT,
  collection_period_start TIMESTAMPTZ,
  collection_period_end   TIMESTAMPTZ,
  -- Loose ref into sdk-evidence. REQUIRED for licensed/partner origins — enforced by
  -- the CHECK below so the rule holds even for a direct SQL writer.
  evidence_blob_ref    TEXT,
  evidence_kind        source_record.evidence_kind NOT NULL DEFAULT 'DOCUMENT',
  mapping_version      TEXT,
  signature            TEXT NOT NULL,
  signature_alg        TEXT NOT NULL DEFAULT 'HMAC-SHA256',
  signed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    collection_period_end IS NULL
    OR collection_period_start IS NULL
    OR collection_period_end >= collection_period_start
  ),
  -- Bought or partner-supplied data must carry its paperwork.
  CHECK (
    origin_class NOT IN ('LICENSED_THIRD_PARTY', 'PARTNER_PROVIDED')
    OR (evidence_blob_ref IS NOT NULL AND length(evidence_blob_ref) > 0)
  )
);

CREATE INDEX IF NOT EXISTS source_rights_attestation_tenant_idx
  ON source_record.source_rights_attestation (tenant_id, origin_class);
CREATE INDEX IF NOT EXISTS source_rights_attestation_capture_idx
  ON source_record.source_rights_attestation (capture_id);
CREATE INDEX IF NOT EXISTS source_rights_attestation_fingerprint_idx
  ON source_record.source_rights_attestation (tenant_id, source_fingerprint);

-- ================================================= source_record.id_crosswalk
-- The external identifier, kept forever. A crosswalk is how a record stays
-- re-findable in the system it came from; overwriting one would silently break the
-- link, so external_system/external_id are immutable and rows are never deleted.
CREATE TABLE IF NOT EXISTS source_record.id_crosswalk (
  crosswalk_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  capture_id      UUID REFERENCES source_record.source_record (capture_id) ON DELETE RESTRICT,
  subject_ref     TEXT,
  external_system TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One external identity maps to one crosswalk row per tenant.
  UNIQUE (tenant_id, external_system, external_id)
);

CREATE INDEX IF NOT EXISTS id_crosswalk_subject_idx
  ON source_record.id_crosswalk (tenant_id, subject_ref)
  WHERE subject_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS id_crosswalk_capture_idx
  ON source_record.id_crosswalk (capture_id);

-- ==================================================== IMMUTABILITY TRIGGERS
-- These are the teeth. Every rule above that says "immutable" is enforced here, so
-- an UPDATE from a future service, a migration script or a psql session fails the
-- same way.

-- source_record: the captured payload and its provenance class are frozen at insert.
-- Everything else (trust_state, normalized, subject_ref, ...) is free to move.
CREATE OR REPLACE FUNCTION source_record.reject_capture_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.raw_evidence IS DISTINCT FROM OLD.raw_evidence THEN
    RAISE EXCEPTION 'source_record.raw_evidence is immutable after insert (capture %)', OLD.capture_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.origin_class IS DISTINCT FROM OLD.origin_class THEN
    RAISE EXCEPTION 'source_record.origin_class is immutable after insert (capture %)', OLD.capture_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_record_immutable_trg ON source_record.source_record;
CREATE TRIGGER source_record_immutable_trg
  BEFORE UPDATE ON source_record.source_record
  FOR EACH ROW EXECUTE FUNCTION source_record.reject_capture_mutation();

-- source_assertion: link-over-merge. The claim itself is frozen; only the supersede
-- columns and status may move, and a DELETE is never allowed.
CREATE OR REPLACE FUNCTION source_record.reject_assertion_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source_assertion rows are append-only — assertion % cannot be deleted', OLD.assertion_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.value IS DISTINCT FROM OLD.value
     OR NEW.value_encrypted IS DISTINCT FROM OLD.value_encrypted
     OR NEW.attribute IS DISTINCT FROM OLD.attribute
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.origin_class IS DISTINCT FROM OLD.origin_class
     OR NEW.confidence IS DISTINCT FROM OLD.confidence
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
     OR NEW.retrieved_at IS DISTINCT FROM OLD.retrieved_at THEN
    RAISE EXCEPTION
      'source_assertion % is immutable — supersede it instead of rewriting the claim', OLD.assertion_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A supersede is one-way: once pointed at a successor it stays pointed there.
  IF OLD.superseded_by IS NOT NULL AND NEW.superseded_by IS DISTINCT FROM OLD.superseded_by THEN
    RAISE EXCEPTION 'source_assertion % is already superseded by %', OLD.assertion_id, OLD.superseded_by
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_assertion_immutable_trg ON source_record.source_assertion;
CREATE TRIGGER source_assertion_immutable_trg
  BEFORE UPDATE OR DELETE ON source_record.source_assertion
  FOR EACH ROW EXECUTE FUNCTION source_record.reject_assertion_mutation();

-- source_rights_attestation: signed means signed.
CREATE OR REPLACE FUNCTION source_record.reject_attestation_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'source_rights_attestation % is immutable once signed — issue a new attestation',
    COALESCE(OLD.attestation_id, NEW.attestation_id)
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS source_rights_attestation_immutable_trg
  ON source_record.source_rights_attestation;
CREATE TRIGGER source_rights_attestation_immutable_trg
  BEFORE UPDATE OR DELETE ON source_record.source_rights_attestation
  FOR EACH ROW EXECUTE FUNCTION source_record.reject_attestation_mutation();

-- id_crosswalk: the external identity is preserved forever. subject_ref may be
-- re-pointed as linkage improves; the external pair may not, and nothing is deleted.
CREATE OR REPLACE FUNCTION source_record.reject_crosswalk_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'id_crosswalk % is preserved forever and cannot be deleted', OLD.crosswalk_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.external_system IS DISTINCT FROM OLD.external_system
     OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'id_crosswalk % external identity is immutable', OLD.crosswalk_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS id_crosswalk_immutable_trg ON source_record.id_crosswalk;
CREATE TRIGGER id_crosswalk_immutable_trg
  BEFORE UPDATE OR DELETE ON source_record.id_crosswalk
  FOR EACH ROW EXECUTE FUNCTION source_record.reject_crosswalk_mutation();
