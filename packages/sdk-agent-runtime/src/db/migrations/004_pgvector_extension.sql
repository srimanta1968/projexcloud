-- Migration 004: enable pgvector + create the default per-tenant embedding
-- schema template (I-2 / TK-3319).
--
-- The vector store probe (TK-3279 / vectorNamespaceCheck) assumes each
-- namespace lives at vector_<namespace>.embedding with a tenant_id
-- column. This migration installs pgvector and stands up a TEMPLATE
-- schema operations can clone per tenant.
--
-- Tier-G tenants route to a separate Pinecone/Qdrant cluster — see
-- docs/v3.1/decisions/p6a-vector-store.md for the choice.

CREATE EXTENSION IF NOT EXISTS vector;

-- Template schema for per-tenant vector partitions. ops/tenant-lifecycle
-- runs `CREATE SCHEMA vector_<namespace>;` and copies the embedding
-- table shape from here. Direct queries against the template schema are
-- not expected — it's a structural reference only.
CREATE SCHEMA IF NOT EXISTS vector_template;

CREATE TABLE IF NOT EXISTS vector_template.embedding (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  source_kind TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  content     TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding   vector(1536),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vector_template_embedding_tenant_idx
  ON vector_template.embedding (tenant_id);

CREATE INDEX IF NOT EXISTS vector_template_embedding_hnsw_idx
  ON vector_template.embedding USING hnsw (embedding vector_cosine_ops);

COMMENT ON SCHEMA vector_template
  IS 'Template schema for per-tenant pgvector partitions. Cloned by tenant-lifecycle on namespace creation; not queried directly.';
COMMENT ON TABLE vector_template.embedding
  IS 'Per-tenant embedding rows. tenant_id is the namespace-isolation key probed by vectorNamespaceCheck.';
