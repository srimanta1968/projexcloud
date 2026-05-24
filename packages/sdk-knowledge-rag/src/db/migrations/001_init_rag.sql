-- Migration 001: sdk-knowledge-rag canonical schema per
-- docs/v3.1/datamodel/P6B-Knowledge-Semantic-DataModel.html §4.
-- Auto-applied by @projexlight/migration-runner (P1 doctrine).

CREATE SCHEMA IF NOT EXISTS rag;

-- ---------------------------------------------------------------------------
-- rag.corpus — per-tenant collection of indexed documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag.corpus (
  corpus_id          TEXT PRIMARY KEY,
  tenant_id          UUID NOT NULL,
  name               TEXT NOT NULL,
  description        TEXT,
  -- FK to agents.vector_namespace_registry (P6A). HARD-isolated per FR-ART-13.
  vector_namespace   TEXT NOT NULL,
  embedding_model    TEXT NOT NULL,
  embedding_dim      INTEGER NOT NULL CHECK (embedding_dim > 0),
  policy_id          UUID NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rag_corpus_tenant_idx ON rag.corpus (tenant_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rag_corpus_tenant_name_uq ON rag.corpus (tenant_id, name);

-- ---------------------------------------------------------------------------
-- rag.document — one row per indexed document.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag.document (
  document_id        TEXT PRIMARY KEY,
  corpus_id          TEXT NOT NULL REFERENCES rag.corpus(corpus_id) ON DELETE CASCADE,
  source_kind        TEXT NOT NULL CHECK (source_kind IN ('uploaded','connector','parsed')),
  -- e.g. media.blob:{blob_id} or external URL.
  source_ref         TEXT NOT NULL,
  title              TEXT,
  author             TEXT,
  language           TEXT,
  indexed_at         TIMESTAMPTZ,
  reindexed_at       TIMESTAMPTZ,
  policy_overrides   JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS rag_document_corpus_idx ON rag.document (corpus_id, indexed_at DESC);
CREATE INDEX IF NOT EXISTS rag_document_source_idx ON rag.document (source_kind, source_ref);

-- ---------------------------------------------------------------------------
-- rag.chunk — chunk metadata (vector lives in vector store, not here).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag.chunk (
  chunk_id           TEXT PRIMARY KEY,
  document_id        TEXT NOT NULL REFERENCES rag.document(document_id) ON DELETE CASCADE,
  chunk_index        INTEGER NOT NULL CHECK (chunk_index >= 0),
  text_preview       TEXT NOT NULL,
  token_count        INTEGER NOT NULL CHECK (token_count >= 0),
  span_start         INTEGER NOT NULL,
  span_end           INTEGER NOT NULL,

  CONSTRAINT rag_chunk_span_order CHECK (span_end >= span_start)
);

CREATE INDEX IF NOT EXISTS rag_chunk_document_idx ON rag.chunk (document_id, chunk_index);
CREATE UNIQUE INDEX IF NOT EXISTS rag_chunk_document_index_uq ON rag.chunk (document_id, chunk_index);

-- ---------------------------------------------------------------------------
-- rag.retrieval — sampled retrieval audit log (per FR-RAG-4).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rag.retrieval (
  retrieval_id          TEXT PRIMARY KEY,
  corpus_id             TEXT NOT NULL REFERENCES rag.corpus(corpus_id) ON DELETE CASCADE,
  requestor_persona_id  UUID NOT NULL,
  agent_run_id          UUID,
  query_text            TEXT NOT NULL,
  top_k                 INTEGER NOT NULL CHECK (top_k > 0),
  hits_returned         INTEGER NOT NULL CHECK (hits_returned >= 0),
  hits_filtered_out     INTEGER NOT NULL DEFAULT 0 CHECK (hits_filtered_out >= 0),
  trace_id              TEXT,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  latency_ms            INTEGER NOT NULL CHECK (latency_ms >= 0)
);

CREATE INDEX IF NOT EXISTS rag_retrieval_corpus_idx   ON rag.retrieval (corpus_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS rag_retrieval_persona_idx  ON rag.retrieval (requestor_persona_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS rag_retrieval_trace_idx    ON rag.retrieval (trace_id) WHERE trace_id IS NOT NULL;

COMMENT ON SCHEMA rag IS 'sdk-knowledge-rag (P6B §5.1). Per-tenant corpora, document metadata, chunk pointers, retrieval audit. Vectors live in the per-tenant vector_namespace, not Postgres.';
