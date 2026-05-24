-- Migration 002: backfill checkpoint table (FR-LIN-5 / TK-3380).
-- Persists per-(pool_index, event_type) high-water marks so the backfill
-- worker can resume after a crash or restart without re-scanning the
-- entire audit ledger. One row per (pool_index, event_type) is enough —
-- the backfill is single-writer per shard.

CREATE TABLE IF NOT EXISTS lineage.backfill_checkpoint (
  pool_index       TEXT NOT NULL,
  event_type       TEXT NOT NULL,
  last_seq         BIGINT NOT NULL DEFAULT 0,
  rows_emitted     BIGINT NOT NULL DEFAULT 0,
  last_run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,

  PRIMARY KEY (pool_index, event_type)
);

CREATE INDEX IF NOT EXISTS lineage_backfill_lastrun_idx
  ON lineage.backfill_checkpoint (last_run_at DESC);

COMMENT ON TABLE lineage.backfill_checkpoint IS
  'FR-LIN-5: resumable lineage backfill from audit events. One row per (pool, event_type).';
