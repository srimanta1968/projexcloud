-- Migration 001: sdk-lead-scoring canonical schema per
-- docs/v3.1/datamodel/P7-Field-Hyperscale-DataModel.html §7.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).

CREATE SCHEMA IF NOT EXISTS lead_scoring;

-- ---------------------------------------------------------------------------
-- lead_scoring.model — one row per (tenant, vertical) model. Per-vertical
-- because FieldOps / Realty / Healthcare weight features differently
-- (Architecture §3B Localize Complexity row "Semantic").
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_scoring.model (
  model_id        TEXT PRIMARY KEY,
  tenant_id       UUID NOT NULL,
  vertical        TEXT NOT NULL,
  trained_at      TIMESTAMPTZ,
  feature_set     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'training' CHECK (
    status IN ('training','active','retired')
  ),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_scoring_model_tenant_idx
  ON lead_scoring.model (tenant_id, status);

-- ---------------------------------------------------------------------------
-- lead_scoring.score — one row per scored lead. Components jsonb stores the
-- per-factor sub-scores (proximity/expertise/intent/storm_impact) for
-- explainability surfaces. trace_id links into sdk-trace.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_scoring.score (
  score_id      TEXT PRIMARY KEY,
  model_id      TEXT NOT NULL REFERENCES lead_scoring.model(model_id) ON DELETE CASCADE,
  -- Logical FK to crm.contact (no hard FK across schemas at MVP).
  contact_id    TEXT NOT NULL,
  score         NUMERIC NOT NULL,
  components    JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS lead_scoring_score_contact_idx
  ON lead_scoring.score (contact_id, computed_at DESC);
CREATE INDEX IF NOT EXISTS lead_scoring_score_model_idx
  ON lead_scoring.score (model_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- lead_scoring.feature_weight — tuned per-feature weights for a model.
-- last_tuned_at lets the auto-tuner skip stable rows.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_scoring.feature_weight (
  weight_id       TEXT PRIMARY KEY,
  model_id        TEXT NOT NULL REFERENCES lead_scoring.model(model_id) ON DELETE CASCADE,
  feature         TEXT NOT NULL,
  weight          NUMERIC NOT NULL,
  last_tuned_at   TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_scoring_feature_weight_uq
  ON lead_scoring.feature_weight (model_id, feature);

COMMENT ON SCHEMA lead_scoring IS 'sdk-lead-scoring (P7 §5.4). Proximity·expertise·intent·storm-impact scoring + next-best-action.';
