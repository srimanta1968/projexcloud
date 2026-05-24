-- Migration 001: sdk-recommendation canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §7.

CREATE SCHEMA IF NOT EXISTS recommendation;

-- ---------------------------------------------------------------------------
-- recommendation.model — per-tenant trained model artifact registry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendation.model (
  model_id          TEXT PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  purpose           TEXT NOT NULL
                      CHECK (purpose IN ('similar-x','next-best-action','churn-risk','upsell')),
  algorithm         TEXT NOT NULL,
  -- Per-tenant artifact namespace — vector-isolated (FR-REC-3).
  vector_namespace  TEXT NOT NULL,
  trained_at        TIMESTAMPTZ,
  feature_flag_id   UUID,
  status            TEXT NOT NULL DEFAULT 'training'
                      CHECK (status IN ('training','active','retired')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rec_model_tenant_idx ON recommendation.model (tenant_id, purpose, status);
CREATE UNIQUE INDEX IF NOT EXISTS rec_model_namespace_uq ON recommendation.model (vector_namespace);

-- ---------------------------------------------------------------------------
-- recommendation.suggestion — per-call output.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendation.suggestion (
  suggestion_id        TEXT PRIMARY KEY,
  model_id             TEXT NOT NULL REFERENCES recommendation.model(model_id) ON DELETE CASCADE,
  subject_persona_id   UUID NOT NULL,
  suggestion_kind      TEXT NOT NULL,
  payload              JSONB NOT NULL,
  score                NUMERIC(5,4) NOT NULL CHECK (score >= 0 AND score <= 1),
  trace_id             TEXT,
  generated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rec_suggestion_model_idx   ON recommendation.suggestion (model_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS rec_suggestion_subject_idx ON recommendation.suggestion (subject_persona_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS rec_suggestion_trace_idx   ON recommendation.suggestion (trace_id) WHERE trace_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- recommendation.feedback — outcome capture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recommendation.feedback (
  feedback_id     TEXT PRIMARY KEY,
  suggestion_id   TEXT NOT NULL REFERENCES recommendation.suggestion(suggestion_id) ON DELETE CASCADE,
  outcome         TEXT NOT NULL CHECK (outcome IN ('accepted','dismissed','ignored')),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rec_feedback_suggestion_idx ON recommendation.feedback (suggestion_id);
CREATE INDEX IF NOT EXISTS rec_feedback_outcome_idx    ON recommendation.feedback (outcome, captured_at DESC);

COMMENT ON SCHEMA recommendation IS 'sdk-recommendation (P6B §5.4). Per-tenant models, suggestions, outcome feedback.';
