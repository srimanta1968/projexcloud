/**
 * @projexlight/sdk-knowledge-rag — public surface.
 *
 * P6B · Per-tenant corpora + retrieval. pgvector for v1 (Tier-G: dedicated
 * vector cluster); embedding worker via sdk-ai-gateway; retrieval applies
 * sdk-policy per hit; namespaces HARD-isolated (re-uses P6A FR-ART-13).
 */
export { migrationsDir } from './db';

// Corpus CRUD (FR-RAG-1).
export { createCorpus, getCorpus, listCorpora } from './services/corpusService';
export type { CreateCorpusInput } from './services/corpusService';

// Document indexing (FR-RAG-1, FR-RAG-3, FR-RAG-6).
export { indexDocument } from './services/indexService';
export type { IndexDocumentInput, IndexDocumentResult } from './services/indexService';

// Retrieval with policy-filtered hits (FR-RAG-4, FR-RAG-5 / AC-2).
export { retrieve } from './services/retrieveService';
export type {
  RetrieveOptions,
  PolicyResolver,
  PolicyResolverInput,
} from './services/retrieveService';

// Pluggable backends — production swaps via setters.
export {
  setEmbeddingBackend,
  setVectorBackend,
  getEmbeddingBackend,
  getVectorBackend,
  HashBucketEmbeddingBackend,
  InMemoryVectorBackend,
  _resetRagBackends,
} from './services/backends';
export type {
  EmbeddingBackend,
  VectorBackend,
  VectorRecord,
} from './services/backends';

// Production pgvector backend (TK-3459) — wire via setVectorBackend(new PgvectorBackend()).
export { PgvectorBackend } from './services/pgvectorBackend';
