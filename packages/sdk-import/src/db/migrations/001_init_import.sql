-- Migration 001: sdk-import — governed import runs (P16 · EP-375 / PCF-02-1).
--
-- sdk-ingest is a write primitive: three endpoints, no mapping, no preview, no
-- dry run, no exception file, no rollback. This schema is the governance layer
-- above it — the part that lets a human see what an import WILL do before it does
-- it, and undo it afterwards.
--
--   import_run       — one governed import, from draft to complete or rolled_back
--   mapping_template — a reusable, versioned column mapping
--   import_exception — the rows that did not make it, with a reason
--   import_lineage   — every entity the run created, so rollback is possible at all
--
-- Three rules are enforced by the DATABASE, not by service code:
--
--   1. COMMIT IDEMPOTENCY. UNIQUE(tenant_id, file_fingerprint, source_kind) means
--      the same file from the same source is ONE run. A retry after a mid-commit
--      crash finds the existing run instead of creating a parallel one, which is
--      what makes "interrupt and retry yields an identical entity set" achievable
--      rather than aspirational.
--   2. ROLLBACK DEADLINE IS DERIVED, NOT SUPPLIED. A trigger stamps
--      committed_at + rollback_window on the transition to complete. A column
--      DEFAULT cannot reference a sibling column, and letting the caller pass the
--      deadline would let it pass a deadline in 2099.
--   3. A TEMPLATE USED BY A COMMITTED RUN IS FROZEN. Editing the mapping that
--      produced already-landed data would make the lineage a lie. Versioning is
--      the supported path: POST a new version, leave the old one intact.
--
-- Idempotent + re-runnable; rollback companion in ../down/001_init_import.down.sql.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS import;

-- ============================================================ ENUM TYPES

-- The run lifecycle. quarantined is terminal-ish (the run is parked for a human);
-- rolled_back is reachable only from complete.
DO $$ BEGIN
  CREATE TYPE import.import_run_status AS ENUM (
    'draft',
    'previewing',
    'mapping',
    'dry_run',
    'committing',
    'complete',
    'quarantined',
    'rolled_back'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- certified templates ship with the platform and are curated; custom ones are a
-- tenant's own. The distinction drives who may edit, not what the mapping can do.
DO $$ BEGIN
  CREATE TYPE import.mapping_template_kind AS ENUM ('certified', 'custom');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What to do when an incoming external id already maps to a known entity.
DO $$ BEGIN
  CREATE TYPE import.crosswalk_strategy AS ENUM (
    'preserve_existing',
    'add_alias',
    'reject_conflict'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- What a lineage row records happening to an entity.
DO $$ BEGIN
  CREATE TYPE import.lineage_action AS ENUM (
    'created',
    'linked',
    'updated',
    'asserted',
    'reversed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================== import.mapping_template
-- Declared BEFORE import_run because a run may reference one.
--
-- (tenant_id, slug, version) is unique: a new version is a NEW ROW, never an edit.
-- field_map / transforms / value_crosswalks are JSONB documents rather than child
-- tables because they are read and written whole, always by the same owner, and
-- never queried field-by-field.
CREATE TABLE IF NOT EXISTS import.mapping_template (
  template_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  slug               TEXT NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  kind               import.mapping_template_kind NOT NULL DEFAULT 'custom',
  version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- Lineage between versions, so "which mapping did v3 come from" is answerable.
  parent_template_id UUID REFERENCES import.mapping_template (template_id) ON DELETE RESTRICT,
  -- { "<source column>": { "target": "...", "confidence": 0.9, "reason": "..." } }
  field_map          JSONB NOT NULL DEFAULT '{}'::jsonb,
  transforms         JSONB NOT NULL DEFAULT '[]'::jsonb,
  value_crosswalks   JSONB NOT NULL DEFAULT '{}'::jsonb,
  crosswalk_strategy import.crosswalk_strategy NOT NULL DEFAULT 'preserve_existing',
  -- Incremented on each committed run that used it. Cheap signal of which mapping
  -- a tenant actually relies on.
  use_count          INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  is_active          BOOLEAN NOT NULL DEFAULT true,
  created_by         TEXT,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug, version)
);

CREATE INDEX IF NOT EXISTS mapping_template_tenant_idx
  ON import.mapping_template (tenant_id, kind, is_active);
CREATE INDEX IF NOT EXISTS mapping_template_slug_idx
  ON import.mapping_template (tenant_id, slug, version DESC);

-- ===================================================== import.import_run
CREATE TABLE IF NOT EXISTS import.import_run (
  run_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  -- Where the rows came from: an uploaded file, a connector pull, an API push.
  -- Free text rather than an enum: the set of adapters grows per deployment, and
  -- an enum would make adding one a migration.
  source_kind        TEXT NOT NULL,
  source_ref         TEXT,
  -- Content hash of the source. The idempotency key, with tenant and source_kind.
  file_fingerprint   TEXT NOT NULL,
  file_name          TEXT,
  status             import.import_run_status NOT NULL DEFAULT 'draft',
  mapping_template_id UUID REFERENCES import.mapping_template (template_id) ON DELETE RESTRICT,
  -- The run's own resolved mapping. Copied from the template at map time so a
  -- later template version cannot retroactively change what this run did.
  field_map          JSONB NOT NULL DEFAULT '{}'::jsonb,
  transform_plan     JSONB,
  preview            JSONB,
  dry_run_result     JSONB,
  -- Loose ref to the sdk-source-record attestation covering this import. The
  -- commit service refuses to run without one.
  attestation_id     UUID,
  row_count          INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  committed_row_count INTEGER CHECK (committed_row_count IS NULL OR committed_row_count >= 0),
  exception_count    INTEGER NOT NULL DEFAULT 0 CHECK (exception_count >= 0),
  -- How long after commit a rollback stays possible. Configurable per run;
  -- the DEADLINE itself is derived from it by trigger, never supplied.
  rollback_window    INTERVAL NOT NULL DEFAULT INTERVAL '24 hours',
  rollback_deadline  TIMESTAMPTZ,
  rolled_back_at     TIMESTAMPTZ,
  rollback_reason    TEXT,
  quarantine_reason  TEXT,
  committed_at       TIMESTAMPTZ,
  started_by         TEXT,
  correlation_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Commit idempotency: one file, one source, one tenant -> one run.
  UNIQUE (tenant_id, file_fingerprint, source_kind),
  -- A complete run has a commit time; an incomplete one does not.
  CHECK (
    (status IN ('complete', 'rolled_back') AND committed_at IS NOT NULL)
    OR (status NOT IN ('complete', 'rolled_back'))
  ),
  CHECK (
    (status = 'rolled_back' AND rolled_back_at IS NOT NULL)
    OR (status <> 'rolled_back' AND rolled_back_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS import_run_tenant_status_idx
  ON import.import_run (tenant_id, status);
CREATE INDEX IF NOT EXISTS import_run_template_idx
  ON import.import_run (mapping_template_id)
  WHERE mapping_template_id IS NOT NULL;
-- Finds runs still inside their rollback window without scanning history.
CREATE INDEX IF NOT EXISTS import_run_rollback_window_idx
  ON import.import_run (tenant_id, rollback_deadline)
  WHERE status = 'complete';

-- ================================================ import.import_exception
-- One row per input row that could not be processed. raw_row keeps the ORIGINAL
-- input verbatim so the exception file a human downloads is the actual data they
-- submitted, not a re-serialization of the platform's interpretation of it.
CREATE TABLE IF NOT EXISTS import.import_exception (
  exception_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  run_id       UUID NOT NULL REFERENCES import.import_run (run_id) ON DELETE CASCADE,
  row_number   INTEGER NOT NULL CHECK (row_number >= 0),
  raw_row      JSONB NOT NULL,
  reason_code  TEXT NOT NULL,
  detail       TEXT,
  column_name  TEXT,
  -- Set when a dry run produced the exception; those are advisory, not failures.
  is_dry_run   BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One exception per (run, row, reason): re-running the same validation does not
  -- multiply the exception file.
  UNIQUE (run_id, row_number, reason_code)
);

CREATE INDEX IF NOT EXISTS import_exception_run_idx
  ON import.import_exception (run_id, row_number);
CREATE INDEX IF NOT EXISTS import_exception_reason_idx
  ON import.import_exception (tenant_id, reason_code);

-- ================================================== import.import_lineage
-- The record of what the run created, and therefore the ONLY thing that makes
-- rollback possible: without a lineage row, a created entity is indistinguishable
-- from one a human made, and reversing it would be guesswork.
CREATE TABLE IF NOT EXISTS import.import_lineage (
  lineage_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL,
  run_id         UUID NOT NULL REFERENCES import.import_run (run_id) ON DELETE CASCADE,
  -- Loose (kind, id) pair rather than an FK: the entities live in other SDKs'
  -- schemas, and a hard FK here would make sdk-import depend on all of them.
  entity_kind    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  action         import.lineage_action NOT NULL DEFAULT 'created',
  row_number     INTEGER CHECK (row_number IS NULL OR row_number >= 0),
  -- Correlates this entity back through the run to the source row and the event
  -- stream, so an auditor can walk in either direction.
  correlation_id UUID NOT NULL,
  reversed_at    TIMESTAMPTZ,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Exactly one lineage row per (run, entity, action): a retried commit that
  -- re-lands the same entity records it once, which is what makes "every created
  -- entity has exactly one lineage row" true under replay.
  UNIQUE (run_id, entity_kind, entity_id, action)
);

CREATE INDEX IF NOT EXISTS import_lineage_run_idx
  ON import.import_lineage (run_id, entity_kind);
CREATE INDEX IF NOT EXISTS import_lineage_entity_idx
  ON import.import_lineage (tenant_id, entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS import_lineage_correlation_idx
  ON import.import_lineage (correlation_id);

-- ========================================================== TRIGGERS

-- Rollback deadline is DERIVED. Stamped on the transition into complete, from the
-- commit time and the run's own window. Never accepted from the caller, and never
-- recomputed afterwards — extending your own deadline retroactively would defeat
-- the point of having one.
CREATE OR REPLACE FUNCTION import.stamp_rollback_deadline()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Once stamped, the deadline and the commit time are frozen. Without this the
    -- window is advisory: any writer could push its own deadline out by a century
    -- and roll back data the platform had already promised was settled.
    IF OLD.rollback_deadline IS NOT NULL
       AND NEW.rollback_deadline IS DISTINCT FROM OLD.rollback_deadline THEN
      RAISE EXCEPTION
        'import_run % rollback_deadline is derived and immutable once stamped (was %)',
        OLD.run_id, OLD.rollback_deadline
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF OLD.committed_at IS NOT NULL AND NEW.committed_at IS DISTINCT FROM OLD.committed_at THEN
      RAISE EXCEPTION 'import_run % committed_at is immutable once set', OLD.run_id
        USING ERRCODE = 'restrict_violation';
    END IF;
    -- Widening the window after the fact would move the deadline in spirit even
    -- though the stamped value stays put, so it is frozen alongside it.
    IF OLD.rollback_deadline IS NOT NULL
       AND NEW.rollback_window IS DISTINCT FROM OLD.rollback_window THEN
      RAISE EXCEPTION 'import_run % rollback_window is frozen once the run has committed', OLD.run_id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.status = 'complete' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'complete') THEN
    IF NEW.committed_at IS NULL THEN
      NEW.committed_at := now();
    END IF;
    -- Derived, never supplied: a caller-provided deadline is discarded.
    NEW.rollback_deadline := NEW.committed_at + NEW.rollback_window;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS import_run_rollback_deadline_trg ON import.import_run;
CREATE TRIGGER import_run_rollback_deadline_trg
  BEFORE INSERT OR UPDATE ON import.import_run
  FOR EACH ROW EXECUTE FUNCTION import.stamp_rollback_deadline();

-- A mapping template referenced by a COMMITTED run is frozen. Editing the mapping
-- that produced already-landed data would make every lineage row that points at it
-- a lie. Bookkeeping columns (use_count, is_active, updated_at, metadata) stay
-- writable — they describe the template's usage, not its behaviour.
CREATE OR REPLACE FUNCTION import.reject_used_template_mutation()
RETURNS TRIGGER AS $$
DECLARE
  used_by UUID;
BEGIN
  SELECT run_id INTO used_by
    FROM import.import_run
   WHERE mapping_template_id = COALESCE(OLD.template_id, NEW.template_id)
     AND status IN ('complete', 'rolled_back')
   LIMIT 1;

  IF used_by IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'mapping_template % was used by committed run % and cannot be deleted', OLD.template_id, used_by
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.field_map IS DISTINCT FROM OLD.field_map
     OR NEW.transforms IS DISTINCT FROM OLD.transforms
     OR NEW.value_crosswalks IS DISTINCT FROM OLD.value_crosswalks
     OR NEW.crosswalk_strategy IS DISTINCT FROM OLD.crosswalk_strategy
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    RAISE EXCEPTION
      'mapping_template % is frozen — it was used by committed run %. Publish a new version instead',
      OLD.template_id, used_by
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mapping_template_frozen_trg ON import.mapping_template;
CREATE TRIGGER mapping_template_frozen_trg
  BEFORE UPDATE OR DELETE ON import.mapping_template
  FOR EACH ROW EXECUTE FUNCTION import.reject_used_template_mutation();
