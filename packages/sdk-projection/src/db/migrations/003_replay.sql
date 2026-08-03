-- Migration 003: deterministic replay (P16 · EP-382).
--
-- When an identity link is retracted or an assertion superseded, the projection must be
-- REBUILT from the assertion log, not patched.
--
-- Patching is the tempting shortcut and it is wrong for a reason that only shows up later:
-- to patch you must know what the retracted assertion contributed, which means trusting a
-- delta computed against a state you no longer have. Two patches applied in a different
-- order then disagree, and nothing in the system can tell you which is right. A replay has
-- no such dependence — it reads the surviving assertions and derives the answer, so the
-- result depends only on the log's CONTENT, never on the path taken to get there.
--
-- The snapshot below is therefore a CACHE plus EVIDENCE, never a source of truth: it can
-- be deleted and rebuilt exactly.

CREATE TABLE IF NOT EXISTS projection.replay_snapshot (
  tenant_id        UUID NOT NULL,
  subject_ref      TEXT NOT NULL,

  /*
   * A stable digest of the projected result. Two replays of the same log must produce the
   * same hash — that is the machine-checkable form of "deterministic", and it is why the
   * hash is over the CANONICAL projection rather than over the raw response (which carries
   * a timestamp and would differ every time).
   */
  content_hash     TEXT NOT NULL,
  projection       JSONB NOT NULL,

  assertion_count  INTEGER NOT NULL DEFAULT 0,
  attribute_count  INTEGER NOT NULL DEFAULT 0,
  /** How many replays have landed here — a repeat is expected and cheap, not an error. */
  replay_count     INTEGER NOT NULL DEFAULT 1,
  last_reason      TEXT,
  last_trigger     TEXT NOT NULL DEFAULT 'manual'
                     CHECK (last_trigger IN ('manual', 'retraction', 'supersede', 'rule_change', 'backfill')),
  duration_ms      INTEGER,
  replayed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, subject_ref)
);

CREATE INDEX IF NOT EXISTS proj_replay_recent_idx
  ON projection.replay_snapshot (tenant_id, replayed_at DESC);

COMMENT ON TABLE projection.replay_snapshot IS
  'sdk-projection (P16 EP-382). Rebuilt-from-log cache + evidence; safe to delete and replay.';
COMMENT ON COLUMN projection.replay_snapshot.content_hash IS
  'Digest of the canonical projection. Equal hashes across replays IS the determinism check.';
