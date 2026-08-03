-- Migration 002: bitemporal contextual-role relationships (P16 · EP-384).
--
-- ADDITIVE. Every column is added with a default that keeps existing rows legal, and no
-- existing column, index or constraint is altered — so the current relationship and
-- role-assignment endpoints behave exactly as before.
--
-- The change is that a subject-object pair is no longer ONE relationship. A person can be
-- a patient's daughter AND their registered carer AND their billing contact at the same
-- time, each starting and ending on its own date and each believed for a different reason.
-- Collapsing those into one edge forces a choice nobody should have to make: either lose
-- the distinction, or overwrite a role that is still true. So role_label distinguishes
-- them and valid_from/valid_to give each its own life.
--
-- TRUST IS SEPARATE FROM VALIDITY. "Is this relationship in force right now" and "how sure
-- are we that it is real" are different questions with different remedies: an expired
-- carer role needs renewing, an unevidenced one needs a document. Merging them into a
-- single status is what makes systems answer "inactive" to both.

ALTER TABLE rebac.relationship
  /* The specific role, e.g. 'daughter', 'registered_carer', 'billing_contact'. NULL keeps
   * pre-existing rows untouched and means "the unlabelled relationship of this kind". */
  ADD COLUMN IF NOT EXISTS role_label TEXT,

  /*
   * How the platform came to believe this:
   *   CONFIRMED  — a human with authority attested it. Needs evidence.
   *   DOCUMENTED — a document supports it (power of attorney, contract). Needs evidence.
   *   CANDIDATE  — inferred or self-asserted, not yet checked. Evidence optional.
   * CANDIDATE is the DEFAULT precisely because it is the only one that needs no evidence:
   * any other default would make existing rows violate the constraint below the moment it
   * was added, and a migration that invalidates live data is not additive.
   */
  ADD COLUMN IF NOT EXISTS trust_state TEXT NOT NULL DEFAULT 'CANDIDATE',

  /** When the role STARTED being true — not when the row was written. */
  ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  /** NULL = still in force. Set on close; the row is never deleted. */
  ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS closed_reason TEXT,

  /*
   * What backs the claim: document ids, attestation ids, `<kind>:<id>` refs. An array
   * because a role can rest on several things at once, and because the count is what the
   * constraint below can check.
   */
  ADD COLUMN IF NOT EXISTS evidence_refs TEXT[] NOT NULL DEFAULT '{}'::TEXT[];

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rel_trust_state_values') THEN
    ALTER TABLE rebac.relationship
      ADD CONSTRAINT rel_trust_state_values
      CHECK (trust_state IN ('CONFIRMED', 'CANDIDATE', 'DOCUMENTED'));
  END IF;

  -- EVIDENCE IS STRUCTURAL, NOT ADVISORY. A CONFIRMED role with nothing behind it is the
  -- dangerous row: it reads as checked to every downstream reader while resting on
  -- nothing. Enforcing it here means such a row cannot exist, however it was written —
  -- a service-layer check alone would be bypassed by any direct insert or backfill.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rel_evidence_required') THEN
    ALTER TABLE rebac.relationship
      ADD CONSTRAINT rel_evidence_required
      CHECK (
        trust_state = 'CANDIDATE'
        -- cardinality(), NOT array_length(): array_length('{}', 1) returns NULL rather
        -- than 0, and a CHECK evaluating to NULL PASSES. Written the obvious way this
        -- constraint silently permits exactly the row it exists to forbid — an
        -- unevidenced CONFIRMED role. cardinality() returns 0 for an empty array.
        OR cardinality(evidence_refs) >= 1
      );
  END IF;

  -- A closed role must have closed AFTER it started; an open one carries no close date.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rel_validity_ordered') THEN
    ALTER TABLE rebac.relationship
      ADD CONSTRAINT rel_validity_ordered
      CHECK (valid_to IS NULL OR valid_to >= valid_from);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rel_closed_reason_shape') THEN
    ALTER TABLE rebac.relationship
      ADD CONSTRAINT rel_closed_reason_shape
      CHECK (closed_reason IS NULL OR valid_to IS NOT NULL);
  END IF;
END $$;

-- One LIVE row per (pair, kind, role_label). Two concurrent 'registered_carer' edges
-- between the same two people is a duplicate, not a second role — but the same pair may
-- hold as many DIFFERENT labels as it needs, and any number of CLOSED historical rows,
-- which is what makes the history keepable.
--
-- Restricted to rows that HAVE a label, i.e. to this feature's own rows. Pre-existing
-- unlabelled edges are deliberately left alone: the original table permits duplicates by
-- design (the graph legitimately holds several edges of one kind between two personas),
-- and retro-fitting a uniqueness rule onto live data would be a behaviour change, not an
-- additive one — it would also simply fail to apply against any tenant that already has
-- such rows, which is exactly what happened when this index was first written without the
-- label predicate.
CREATE UNIQUE INDEX IF NOT EXISTS rel_live_role_idx
  ON rebac.relationship (persona_a, persona_b, kind, role_label)
  WHERE valid_to IS NULL AND role_label IS NOT NULL;

-- The "what roles hold right now" read.
CREATE INDEX IF NOT EXISTS rel_role_live_idx
  ON rebac.relationship (persona_a, persona_b, role_label)
  WHERE valid_to IS NULL;
-- Provenance: closed roles stay directly queryable rather than needing a full scan.
CREATE INDEX IF NOT EXISTS rel_role_history_idx
  ON rebac.relationship (persona_a, persona_b, valid_from DESC);
CREATE INDEX IF NOT EXISTS rel_trust_idx
  ON rebac.relationship (trust_state) WHERE valid_to IS NULL;

COMMENT ON COLUMN rebac.relationship.trust_state IS
  'How the claim is believed. CONFIRMED/DOCUMENTED require evidence_refs; CANDIDATE does not.';
COMMENT ON COLUMN rebac.relationship.valid_to IS
  'NULL = in force. Closing SETS this; the row is never deleted, so provenance survives.';
