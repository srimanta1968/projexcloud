-- sdk-catalog-index 001 — global SDK catalog RAG store (P9.2 / Epic A, TK-3457/3458).
--
-- Auto-applied on boot by @projexlight/migration-runner. Lives in the
-- global-catalog pool: SDK manifests are identical for every tenant, so this is
-- GLOBAL state, NOT the per-tenant rag.* corpus. The 384-dim bge-small vector
-- space here is deliberately separate from the 1536-dim vector_template the
-- agent-runtime uses for tenant RAG.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS catalog;

-- One row per published SDK. content_hash lets the sync job skip unchanged SDKs.
CREATE TABLE IF NOT EXISTS catalog.sdk (
  name           text PRIMARY KEY,            -- @projexlight/sdk-billing
  version        text,
  summary        text NOT NULL,
  tags           text[] NOT NULL DEFAULT '{}',
  tier           text NOT NULL DEFAULT 'domain',   -- 'foundation' | 'domain'
  pool_placement text,
  content_hash   text NOT NULL,               -- sha256(manifest) → incremental sync
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- One row per endpoint. Carries the Epic B payload/auth/kind columns; sync
-- populates them as manifests gain them (defaults are backward-compatible).
CREATE TABLE IF NOT EXISTS catalog.endpoint (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sdk_name        text NOT NULL REFERENCES catalog.sdk(name) ON DELETE CASCADE,
  method          text NOT NULL,
  path            text NOT NULL,
  kind            text NOT NULL DEFAULT 'query',   -- ingest|bulk|query|mutation|webhook
  description     text,
  request_schema  jsonb,
  response_schema jsonb,
  auth_scopes     text[] NOT NULL DEFAULT '{}',
  UNIQUE (sdk_name, method, path)
);
CREATE INDEX IF NOT EXISTS catalog_endpoint_sdk_idx  ON catalog.endpoint (sdk_name);
CREATE INDEX IF NOT EXISTS catalog_endpoint_kind_idx ON catalog.endpoint (kind);

-- One embeddable natural-language card per sdk / endpoint / scenario / ingest.
-- 384-dim bge-small space; HNSW cosine index for the retrieve hot path.
CREATE TABLE IF NOT EXISTS catalog.embedding (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_kind        text NOT NULL,             -- 'sdk' | 'endpoint' | 'scenario' | 'ingest'
  ref_id          text NOT NULL,             -- sdk name or endpoint id
  sdk_name        text NOT NULL REFERENCES catalog.sdk(name) ON DELETE CASCADE,
  card            text NOT NULL,             -- the text that was embedded
  embedding       vector(384) NOT NULL,
  embedding_model text NOT NULL DEFAULT 'bge-small-en-v1.5',
  UNIQUE (ref_kind, ref_id)
);
CREATE INDEX IF NOT EXISTS catalog_embedding_hnsw_idx
  ON catalog.embedding USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS catalog_embedding_sdk_idx ON catalog.embedding (sdk_name);

-- Single-row version marker. The sync job bumps `version` whenever any SDK
-- changes; MCP hot-index instances LISTEN/poll this to reload in memory.
CREATE TABLE IF NOT EXISTS catalog.sync_state (
  id        int PRIMARY KEY DEFAULT 1,
  version   bigint NOT NULL DEFAULT 0,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_sync_state_single CHECK (id = 1)
);
INSERT INTO catalog.sync_state (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

COMMENT ON SCHEMA catalog IS 'Global SDK catalog RAG store (P9.2). Source of truth for the build planner + registry MCP retrieval; auto-synced from sdk-capability.json manifests.';
