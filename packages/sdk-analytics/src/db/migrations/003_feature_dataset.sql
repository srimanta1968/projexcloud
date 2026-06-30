-- Migration 003: ML feature / training-dataset builder (P12 · E1).
-- Forward-only; additive. A dataset_spec declares how to window an asset's
-- sensor time-series into feature vectors; a dataset_build records each
-- materialization (row_count + lineage_ref for reproducibility — TK e292d33e).
-- `asset_id` is a plain uuid (no cross-schema FK) so this is order-independent.

CREATE TABLE IF NOT EXISTS analytics.dataset_spec (
  spec_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  name          text NOT NULL,
  asset_id      uuid NOT NULL,
  sensor_ids    uuid[],                                    -- null => all sensors
  bucket_grain  text NOT NULL DEFAULT 'minute',            -- minute | hour | day
  aggregations  text[] NOT NULL DEFAULT ARRAY['avg','min','max','last','count'],
  label_source  jsonb,                                     -- event/evidence labeling (TK 9ac502a1)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_dataset_spec_unique UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS analytics_dataset_spec_tenant_idx ON analytics.dataset_spec (tenant_id);

CREATE TABLE IF NOT EXISTS analytics.dataset_build (
  build_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  spec_id       uuid NOT NULL REFERENCES analytics.dataset_spec(spec_id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL,
  window_from   timestamptz NOT NULL,
  window_to     timestamptz NOT NULL,
  row_count     integer NOT NULL DEFAULT 0,
  labeled_count integer NOT NULL DEFAULT 0,               -- TK 9ac502a1
  lineage_ref   text,                                     -- TK e292d33e
  export_ref    text,                                     -- TK a7937433 (warehouse/object-store)
  built_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_dataset_build_spec_idx ON analytics.dataset_build (spec_id, built_at DESC);
