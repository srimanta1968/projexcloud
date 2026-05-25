/**
 * @projexlight/sdk-registry — P9 / E2
 *
 * Build-time scanner + normalized catalog + runtime Registry API for the
 * SDK Discoverability layer. Consumed by E3 (MCP servers), E5 (CLI),
 * and E6 (cloud builder agent).
 *
 * Phases:
 *   Phase 1 (this commit) — scanner, catalog, dependency graph, runtime
 *     API with substring-based searchByIntent fallback.
 *   Phase 2 (E2.F3)        — bge-small-en-v1.5 embedding index via
 *     @huggingface/transformers; searchByIntent swaps to ANN.
 *   Phase 3 (E2.F6)        — getScaffold tree generator (full TS+SQL
 *     wiring stub returned to CLI/agent for the customer to land).
 */

export * from './types';
export { scanWorkspace, type ScanResult, type ScanOptions, type ScanStatus } from './scanner';
export {
  buildCatalog,
  serializeCatalog,
  catalogContentHash,
  type BuildCatalogOptions,
} from './catalog';
export {
  loadRegistry,
  registryFromCatalog,
  getScaffoldStub,
  type Registry,
  type LoadRegistryOptions,
  type RegistryOptions,
} from './registry';
export {
  createEmbedder,
  planEmbeddings,
  buildEmbeddingIndex,
  serializeEmbeddingIndex,
  writeEmbeddingIndex,
  loadEmbeddingIndex,
  embeddingsContentHash,
  cosineSimilarity,
  searchEmbeddings,
  EMBEDDING_MODEL,
  EMBEDDING_DTYPE,
  EMBEDDING_DIM,
  type EmbedderHandle,
  type EmbeddingIndex,
  type EmbeddingRecordMeta,
  type EmbeddingKind,
  type SearchHit,
  type SerializedEmbeddings,
} from './embeddings';
