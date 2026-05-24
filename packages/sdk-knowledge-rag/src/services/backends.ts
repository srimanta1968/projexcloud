/**
 * Pluggable backend interfaces for sdk-knowledge-rag.
 *
 * Production swaps these via `setEmbeddingBackend()` / `setVectorBackend()`.
 * The defaults are a deterministic hash-bucket embedder + an in-memory
 * vector index — sufficient for unit tests, dev workstations, and the
 * AC-2 policy-filter integration test which doesn't care about embedding
 * quality, only about isolation + policy enforcement.
 *
 * Real backends:
 *   - EmbeddingBackend → sdk-ai-gateway (rag.embed SKU, FR-RAG-3)
 *   - VectorBackend    → pgvector per-tenant schema (Tier-S/P) or
 *                        Pinecone/Qdrant namespace (Tier-G)
 */

import crypto from 'crypto';

export interface EmbeddingBackend {
  /** Returns one embedding vector per input text, in input order. */
  embed(input: { texts: string[]; model: string; tenant_id: string }): Promise<number[][]>;
  /** Reported dim of the model. */
  dim(model: string): number;
}

export interface VectorRecord {
  chunk_id: string;
  vector: number[];
  /** Subset of chunk metadata replicated into the vector store so a
   *  retrieve() call doesn't need to JOIN back to Postgres before
   *  applying the policy filter. */
  metadata: {
    corpus_id: string;
    document_id: string;
    tenant_id: string;
    /** Per-document policy refinements (rag.document.policy_overrides). */
    policy_overrides?: Record<string, unknown>;
    text_preview: string;
  };
}

export interface VectorBackend {
  /** Idempotent upsert by chunk_id within the namespace. */
  upsert(namespace: string, records: VectorRecord[]): Promise<void>;
  /** Returns up to top_k chunks ranked by cosine similarity (descending). */
  query(input: {
    namespace: string;
    query_vector: number[];
    top_k: number;
  }): Promise<Array<VectorRecord & { score: number }>>;
  /** Drops every record in the namespace — used by tenant offboarding. */
  drop(namespace: string): Promise<void>;
}

/* ============================================================
 * Defaults: deterministic, in-process, sufficient for tests.
 * ============================================================ */

const DEFAULT_DIM = 64;

/**
 * Hash-bucket embedder: tokenizes text, hashes each token, adds to a
 * fixed-size float vector. Cosine similarity over these vectors is
 * meaningful for token overlap — good enough for AC-2 testing without
 * pulling in a real model.
 */
export class HashBucketEmbeddingBackend implements EmbeddingBackend {
  constructor(private readonly dimension: number = DEFAULT_DIM) {}

  async embed(input: { texts: string[]; model: string; tenant_id: string }): Promise<number[][]> {
    return input.texts.map((t) => this.embedOne(t));
  }

  dim(_model: string): number {
    return this.dimension;
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0);
    for (const token of tokens) {
      const bucket = this.bucketOf(token);
      vec[bucket] += 1;
    }
    // L2 normalize so cosine === dot product
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm;
    return vec;
  }

  private bucketOf(token: string): number {
    const h = crypto.createHash('md5').update(token).digest();
    // Use first 4 bytes as uint32, modulo dimension.
    const n = h.readUInt32BE(0);
    return n % this.dimension;
  }
}

/**
 * In-memory vector store keyed by namespace. Cross-namespace queries
 * are physically impossible (different Map entries), which matches the
 * FR-RAG-7 HARD-isolated namespace guarantee in test environments.
 */
export class InMemoryVectorBackend implements VectorBackend {
  private readonly stores = new Map<string, Map<string, VectorRecord>>();

  async upsert(namespace: string, records: VectorRecord[]): Promise<void> {
    let store = this.stores.get(namespace);
    if (!store) {
      store = new Map();
      this.stores.set(namespace, store);
    }
    for (const r of records) store.set(r.chunk_id, r);
  }

  async query(input: { namespace: string; query_vector: number[]; top_k: number }): Promise<Array<VectorRecord & { score: number }>> {
    const store = this.stores.get(input.namespace);
    if (!store) return [];
    const scored: Array<VectorRecord & { score: number }> = [];
    for (const record of store.values()) {
      scored.push({ ...record, score: cosine(input.query_vector, record.vector) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, input.top_k);
  }

  async drop(namespace: string): Promise<void> {
    this.stores.delete(namespace);
  }
}

function cosine(a: number[], b: number[]): number {
  // Both vectors are already L2-normalized by the embedder, so dot product
  // is the cosine. Length mismatch returns 0 (defensive — should not happen
  // when caller honours dim()).
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/* ============================================================
 * Singleton registry — production callers swap via setters.
 * ============================================================ */

let _embedding: EmbeddingBackend = new HashBucketEmbeddingBackend();
let _vector: VectorBackend = new InMemoryVectorBackend();

export function setEmbeddingBackend(backend: EmbeddingBackend): void {
  _embedding = backend;
}

export function setVectorBackend(backend: VectorBackend): void {
  _vector = backend;
}

export function getEmbeddingBackend(): EmbeddingBackend {
  return _embedding;
}

export function getVectorBackend(): VectorBackend {
  return _vector;
}

/** Test/dev hook — restore defaults between suites. */
export function _resetRagBackends(): void {
  _embedding = new HashBucketEmbeddingBackend();
  _vector = new InMemoryVectorBackend();
}
