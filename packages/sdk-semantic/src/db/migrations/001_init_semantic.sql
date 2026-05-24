-- Migration 001: sdk-semantic canonical schema (G9 closer · 6 types) per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §10.
-- Auto-applied by @projexlight/migration-runner.
--
-- Six typed primitives that close G9:
--   1. SemanticObject  — typed instance of a domain concept
--   2. SemanticRelation — typed relationships beyond ReBAC
--   3. CapabilityGraph — valid SDK ops per object type
--   4. DomainOntology  — per-vertical bundles
--   5. SemanticIntent  — typed goal; agents plan from Intents
--   6. SemanticPolicy  — ontology-aware authz (IQL → ABAC + ReBAC)

CREATE SCHEMA IF NOT EXISTS semantic;

-- ---------------------------------------------------------------------------
-- semantic.ontology — per-vertical bundles (Healthcare, Realty, Seva v1).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.ontology (
  ontology_id          TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  version              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','active','deprecated','retired')),
  parent_ontology_id   TEXT REFERENCES semantic.ontology(ontology_id),
  bundle_ref           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_ontology_name_version_uq UNIQUE (name, version)
);

CREATE INDEX IF NOT EXISTS semantic_ontology_active_idx ON semantic.ontology (name) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- semantic.object_type — Type 1 of 6 — SemanticObject.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.object_type (
  object_type_id     TEXT PRIMARY KEY,
  ontology_id        TEXT NOT NULL REFERENCES semantic.ontology(ontology_id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  attribute_schema   JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Source SDK + table — e.g. persona.persona_ext:patient_chart.
  backed_by          TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_object_type_name_uq UNIQUE (ontology_id, name)
);

CREATE INDEX IF NOT EXISTS semantic_object_type_ontology_idx ON semantic.object_type (ontology_id, name);

-- ---------------------------------------------------------------------------
-- semantic.relation_type — Type 2 of 6 — SemanticRelation.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.relation_type (
  relation_type_id      TEXT PRIMARY KEY,
  ontology_id           TEXT NOT NULL REFERENCES semantic.ontology(ontology_id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  from_object_type_id   TEXT NOT NULL REFERENCES semantic.object_type(object_type_id) ON DELETE CASCADE,
  to_object_type_id     TEXT NOT NULL REFERENCES semantic.object_type(object_type_id) ON DELETE CASCADE,
  cardinality           TEXT NOT NULL CHECK (cardinality IN ('1:1','1:N','N:N')),
  rebac_kind_mapping    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_relation_name_uq UNIQUE (ontology_id, name, from_object_type_id, to_object_type_id)
);

CREATE INDEX IF NOT EXISTS semantic_relation_ontology_idx ON semantic.relation_type (ontology_id);
CREATE INDEX IF NOT EXISTS semantic_relation_from_to_idx  ON semantic.relation_type (from_object_type_id, to_object_type_id);

-- ---------------------------------------------------------------------------
-- semantic.capability_graph_edge — Type 3 of 6 — CapabilityGraph.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.capability_graph_edge (
  edge_id             TEXT PRIMARY KEY,
  object_type_id      TEXT NOT NULL REFERENCES semantic.object_type(object_type_id) ON DELETE CASCADE,
  tool_sku            TEXT NOT NULL,
  requires_relation   TEXT REFERENCES semantic.relation_type(relation_type_id),
  pre_conditions      JSONB NOT NULL DEFAULT '{}'::jsonb,
  post_conditions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_capability_unique UNIQUE (object_type_id, tool_sku)
);

CREATE INDEX IF NOT EXISTS semantic_capability_object_idx ON semantic.capability_graph_edge (object_type_id);
CREATE INDEX IF NOT EXISTS semantic_capability_sku_idx    ON semantic.capability_graph_edge (tool_sku);

-- ---------------------------------------------------------------------------
-- semantic.intent — Type 5 of 6 — SemanticIntent.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.intent (
  intent_id                TEXT PRIMARY KEY,
  tenant_id                UUID NOT NULL,
  ontology_id              TEXT NOT NULL REFERENCES semantic.ontology(ontology_id),
  goal                     TEXT NOT NULL,
  subject_object_type_id   TEXT NOT NULL REFERENCES semantic.object_type(object_type_id),
  parameters_schema        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_intent_goal_uq UNIQUE (tenant_id, goal)
);

CREATE INDEX IF NOT EXISTS semantic_intent_tenant_idx ON semantic.intent (tenant_id, goal);

-- ---------------------------------------------------------------------------
-- semantic.intent_plan — planner output per (intent, context).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.intent_plan (
  plan_id                       TEXT PRIMARY KEY,
  intent_id                     TEXT NOT NULL REFERENCES semantic.intent(intent_id) ON DELETE CASCADE,
  subject_id                    TEXT NOT NULL,
  steps                         JSONB NOT NULL,
  generated_by_agent_run_id     UUID,
  generated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                        TEXT NOT NULL DEFAULT 'proposed'
                                  CHECK (status IN ('proposed','approved','executing','completed','abandoned'))
);

CREATE INDEX IF NOT EXISTS semantic_plan_intent_idx ON semantic.intent_plan (intent_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS semantic_plan_status_idx ON semantic.intent_plan (status, generated_at DESC);

-- ---------------------------------------------------------------------------
-- semantic.policy — Type 6 of 6 — SemanticPolicy.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.policy (
  policy_id          TEXT PRIMARY KEY,
  tenant_id          UUID,
  ontology_id        TEXT NOT NULL REFERENCES semantic.ontology(ontology_id),
  name               TEXT NOT NULL,
  description        TEXT,
  iql_source         TEXT NOT NULL,
  compiled_abac      TEXT NOT NULL,
  compiled_rebac     JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','deprecated')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_policy_name_uq UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS semantic_policy_active_idx ON semantic.policy (ontology_id) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- semantic.cross_domain_bridge — explicit ontology→ontology bridges.
-- Default read-only; cross-tenant bridges require consent (PRD R-7).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS semantic.cross_domain_bridge (
  bridge_id                       TEXT PRIMARY KEY,
  from_object_type_id             TEXT NOT NULL REFERENCES semantic.object_type(object_type_id) ON DELETE CASCADE,
  to_object_type_id               TEXT NOT NULL REFERENCES semantic.object_type(object_type_id) ON DELETE CASCADE,
  access_mode                     TEXT NOT NULL DEFAULT 'read-only'
                                    CHECK (access_mode IN ('read-only','read-write')),
  requires_cross_tenant_consent   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT semantic_bridge_unique UNIQUE (from_object_type_id, to_object_type_id)
);

CREATE INDEX IF NOT EXISTS semantic_bridge_from_idx ON semantic.cross_domain_bridge (from_object_type_id);
CREATE INDEX IF NOT EXISTS semantic_bridge_to_idx   ON semantic.cross_domain_bridge (to_object_type_id);

COMMENT ON SCHEMA semantic IS 'sdk-semantic (P6B §5.7 · G9 closer). Six types: ontology, object_type, relation_type, capability_graph_edge, intent + intent_plan, policy + cross_domain_bridge.';
