-- Migration 001 (P10/E6): Healthcare EMPI / probabilistic MDM.
-- Auto-applied by @projexlight/migration-runner on api-gateway startup.
-- Architecture v3.2 §11A.10. Additive — the deterministic resolver path is
-- untouched; this schema records PROBABILISTIC candidate links + reversible
-- merges + match-quality samples.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS empi;

-- Candidate links represent UNCERTAIN matches as POSSIBLY_SAME — never a forced
-- merge. Each carries a confidence (0..1) and provenance (which fields matched).
CREATE TABLE IF NOT EXISTS empi.candidate_link (
  link_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id_a      UUID NOT NULL,
  person_id_b      UUID NOT NULL,
  confidence       NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  match_type       TEXT NOT NULL DEFAULT 'POSSIBLY_SAME' CHECK (match_type IN ('POSSIBLY_SAME')),
  provenance       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'merged', 'rejected', 'superseded')),
  -- sdk-approval request gating a steward decision (NULL until queued).
  steward_request_id UUID,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (person_id_a <> person_id_b)
);

CREATE INDEX IF NOT EXISTS candidate_link_a_idx ON empi.candidate_link (person_id_a);
CREATE INDEX IF NOT EXISTS candidate_link_b_idx ON empi.candidate_link (person_id_b);
CREATE INDEX IF NOT EXISTS candidate_link_band_idx ON empi.candidate_link (confidence);
CREATE INDEX IF NOT EXISTS candidate_link_open_idx ON empi.candidate_link (status) WHERE status = 'open';

-- Merge events are event-sourced and REVERSIBLE — no destructive deletes.
-- An unmerge writes a compensating row referencing the merge it reverses.
CREATE TABLE IF NOT EXISTS empi.merge_event (
  merge_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id             UUID,
  surviving_person_id UUID NOT NULL,
  merged_person_id    UUID NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('merge', 'unmerge')),
  reverses_merge_id   UUID REFERENCES empi.merge_event(merge_id),
  decided_by          TEXT,
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merge_event_surviving_idx ON empi.merge_event (surviving_person_id);
CREATE INDEX IF NOT EXISTS merge_event_kind_idx ON empi.merge_event (kind, created_at DESC);

-- Match-quality samples for calibration (ECE). actual_match is the steward
-- ground truth, NULL until adjudicated.
CREATE TABLE IF NOT EXISTS empi.match_outcome (
  outcome_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id              UUID REFERENCES empi.candidate_link(link_id) ON DELETE SET NULL,
  predicted_confidence NUMERIC(5,4) NOT NULL,
  actual_match         BOOLEAN,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS match_outcome_labeled_idx ON empi.match_outcome (actual_match)
  WHERE actual_match IS NOT NULL;
