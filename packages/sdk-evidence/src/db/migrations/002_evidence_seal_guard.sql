-- Migration 002: encounter-seal guard for evidence.capture.
-- Enforces FR-EVD-5 / AC-11: "Sealing an encounter prevents new evidence
-- captures referencing it." The trigger runs server-side so even a buggy
-- client that bypasses the app guard cannot insert a capture against a
-- sealed encounter.
--
-- Co-location assumption: this trigger reads engagement.encounter, so it
-- requires evidence + engagement to live in the SAME Postgres pool.
-- That holds today (both land in the App Pool per the Pool Placement
-- Matrix). When sdk-evidence migrates to its own dedicated Evidence Pool
-- per the data model §3, this trigger becomes a no-op and the app-level
-- guard in assertEncounterNotSealed() carries the load.
--
-- Auto-applied by @projexlight/migration-runner (forward-only, sha256-tracked).

-- ---------------------------------------------------------------------------
-- Trigger function. Returns NEW so successful inserts proceed; RAISE for
-- sealed encounters short-circuits with SQLSTATE 'P0001' (raise_exception)
-- which the app maps to HTTP 409 Conflict.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evidence.block_capture_on_sealed_encounter()
RETURNS TRIGGER AS $$
DECLARE
  encounter_state TEXT;
BEGIN
  -- Use TRY block via EXCEPTION block: if engagement schema is missing
  -- (multi-pool deploy where evidence and engagement are split), let the
  -- insert proceed and rely on the app-level guard. The MISSING_TABLE
  -- handler swallows the lookup; everything else re-raises.
  BEGIN
    SELECT state INTO encounter_state
      FROM engagement.encounter
     WHERE encounter_id = NEW.encounter_id;
  EXCEPTION
    WHEN undefined_table THEN
      RETURN NEW;
    WHEN undefined_schema THEN
      RETURN NEW;
  END;

  IF encounter_state IS NULL THEN
    RAISE EXCEPTION
      'evidence.capture.encounter_id % does not exist in engagement.encounter',
      NEW.encounter_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF encounter_state = 'sealed' THEN
    RAISE EXCEPTION
      'cannot insert evidence.capture for sealed encounter %', NEW.encounter_id
      USING ERRCODE = 'check_violation',
            HINT    = 'Once an encounter is sealed (FR-EVD-5), no new captures may reference it. Open a new encounter for follow-up evidence.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Bind the trigger to BEFORE INSERT (and BEFORE UPDATE OF encounter_id in
-- case some future code path re-points an existing capture row).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS evidence_capture_seal_guard ON evidence.capture;
CREATE TRIGGER evidence_capture_seal_guard
  BEFORE INSERT OR UPDATE OF encounter_id ON evidence.capture
  FOR EACH ROW EXECUTE FUNCTION evidence.block_capture_on_sealed_encounter();

COMMENT ON FUNCTION evidence.block_capture_on_sealed_encounter()
  IS 'P7 FR-EVD-5 / AC-11: blocks new captures referencing a sealed encounter.';
